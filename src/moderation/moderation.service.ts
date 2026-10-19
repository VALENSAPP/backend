import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PolicyEngineService } from './policy-engine.service';
import {
  AIModerationResponse,
  CommentModerationInput,
  ModerationCheckInput,
  ModerationCheckResult,
  ModerationDecisionType,
  ModerationResult,
  PostModerationInput,
  ProductModerationInput,
  SeverityLevel,
} from './moderation.types';
import { ModerationCategory, ModerationDecision, ModerationCaseStatus, AccountViolationAction, AccountStanding } from '@prisma/client';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private readonly geminiApiKey?: string;
  private readonly openaiApiKey?: string;
  private readonly provider: 'gemini' | 'openai' | 'auto';

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly policyEngine: PolicyEngineService,
  ) {
    this.geminiApiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY;
    this.openaiApiKey =
      this.configService.get<string>('OPENAI_API_KEY') ||
      process.env.OPENAI_API_KEY;

    const configProvider = (
      this.configService.get<string>('AI_MODERATION_PROVIDER') ||
      process.env.AI_MODERATION_PROVIDER ||
      'auto'
    ).toLowerCase();

    if (configProvider === 'gemini' || configProvider === 'openai') {
      this.provider = configProvider;
    } else {
      this.provider = 'auto';
    }
  }

  /**
   * Central Moderation Check API (Spec Section 2)
   * Universal endpoint for Posts, Comments, Battles, Marketplace, DMs, etc.
   */
  async checkContent(input: ModerationCheckInput): Promise<ModerationCheckResult> {
    const {
      user_id,
      content_id,
      content_type,
      feature,
      text,
      media_refs = [],
      language = 'en',
      reply_to_content_id,
      context_ids = [],
    } = input;

    // 1. Fetch user standing context
    const user = await (this.prisma as any).user.findUnique({
      where: { id: user_id },
      select: {
        id: true,
        accountStanding: true,
        standingStrikeCount: true,
        standingWarningCount: true,
      },
    });

    const userStanding = user?.accountStanding || 'GOOD';

    // 2. Bilingual system prompt (English and Portuguese aware)
    const systemPrompt = `You are the Central Trust & Safety Policy Classifier for Valens (a platform where reputation is earned, not bought).
Your task is to analyze user-generated content across features (Posts, Comments, Battles, DMs, Marketplace).
Support both English and Portuguese content seamlessly.

Classify content across 2 dimensions:
1. isRelevant:
   - Reject keyboard mash, gibberish (e.g. "asdfghjkl", "111111"), scam advertisements, fraudulent crypto links, or spam bot dumps.
2. isSafe:
   - Identify: hate speech/discrimination, targeted insults/harassment, credible violence/threats, sexual/NSFW exploitation, child safety risks, scams/doxxing.

Categories to detect in "flags":
- "child_safety", "child_exploitation" (Critical)
- "credible_violence", "terrorism", "self_harm" (Critical)
- "hate_speech", "doxxing", "harassment_severe" (Severe)
- "harassment", "targeted_insult", "bullying", "scam", "nsfw" (Targeted)
- "profanity", "mild_toxicity", "spam_caption", "gibberish", "off_topic" (Mild)

Respond strictly in valid JSON format:
{
  "isRelevant": boolean,
  "isSafe": boolean,
  "confidence": number (0.0 to 1.0),
  "flags": string[],
  "reason": string
}`;

    const userPrompt = `Content Type: ${content_type}
Feature Context: ${feature}
Language: ${language}
Parent Reply ID: ${reply_to_content_id || 'none'}
Context IDs: ${context_ids.join(', ') || 'none'}
User Text: "${text || ''}"
Media URLs: ${media_refs.slice(0, 3).join(', ') || 'none'}`;

    let aiRes: AIModerationResponse;
    try {
      if (this.provider === 'openai' && this.openaiApiKey) {
        aiRes = await this.runOpenAIModeration(systemPrompt, userPrompt, media_refs);
      } else if (this.provider === 'gemini' && this.geminiApiKey) {
        aiRes = await this.runGeminiModeration(systemPrompt, userPrompt, media_refs);
      } else if (this.openaiApiKey) {
        aiRes = await this.runOpenAIModeration(systemPrompt, userPrompt, media_refs);
      } else if (this.geminiApiKey) {
        aiRes = await this.runGeminiModeration(systemPrompt, userPrompt, media_refs);
      } else {
        const local = this.runLocalRules(text || '');
        aiRes = {
          isSafe: local.status === 'APPROVED',
          isRelevant: true,
          confidence: 0.8,
          flags: local.flaggedLabels || [],
          reason: local.reason || 'Local check',
        };
      }
    } catch (err: any) {
      this.logger.error(`AI moderation check failed: ${err.message}`, err.stack);
      const local = this.runLocalRules(text || '');
      aiRes = {
        isSafe: local.status === 'APPROVED',
        isRelevant: true,
        confidence: 0.7,
        flags: local.flaggedLabels || [],
        reason: 'Automated fallback evaluation',
      };
    }

    // 3. Evaluate via Policy Engine (Spec Section 3)
    const policyResult = this.policyEngine.evaluate(aiRes, {
      feature,
      userStanding,
      priorViolationsCount: user?.standingStrikeCount || 0,
    });

    // Return normalized evaluation result without generating cases or penalizing draft checks
    return {
      decision: policyResult.decision,
      risk_level: policyResult.severity as SeverityLevel,
      categories: policyResult.categories,
      confidence: Math.round((aiRes.confidence || 0.8) * 100) / 100,
      reason_code: policyResult.reasonCode,
      human_review_required: policyResult.humanReviewRequired,
    };
  }

  /**
   * Evaluate a post for relevance and content safety guidelines (including Caption & Text)
   */
  async evaluatePost(input: PostModerationInput): Promise<ModerationResult> {
    const textPieces = [
      input.caption ? `Caption / Title: "${input.caption}"` : '',
      input.text ? `Post Text Content: "${input.text}"` : '',
      input.hashtag && input.hashtag.length > 0 ? `Hashtags: ${input.hashtag.join(', ')}` : '',
      input.type ? `Post Type: ${input.type}` : '',
      input.format ? `Format: ${input.format}` : '',
    ].filter(Boolean);

    const fullText = textPieces.join('\n');
    const images = (input.images || []).filter((img) => typeof img === 'string' && img.startsWith('http'));

    const systemPrompt = `You are an AI Content Moderator for a social & marketplace platform (Valens).
Your task is to evaluate posts uploaded by users, paying close attention to the CAPTION, POST TEXT, and ATTACHED IMAGES.

Evaluate against 2 core criteria:
1. RELEVANCE & INTEGRITY (isRelevant):
   - CAPTION / NAME CHECK: Reject/flag if the caption or title is gibberish/keyboard smash (e.g. "asdfghjkl", "111111", "aaaaaa"), spam links, scam promotions (e.g. "free money click here", "@telegram_bot"), crypto pump schemes, or completely meaningless text.
   - Genuine user thoughts, descriptions, creative captions, and community conversations ARE RELEVANT.
2. SAFETY & COMMUNITY STANDARDS (isSafe):
   - Reject/flag: Hate speech, profanity/vulgarity in caption or text, harassment/bullying, sexual/pornographic/NSFW content, extreme gore/violence/weapons, illegal drugs/contraband, scam flyers, phishing.

Respond strictly in valid JSON format:
{
  "isRelevant": boolean,
  "isSafe": boolean,
  "confidence": number (0.0 to 1.0),
  "flags": string[] (e.g. ["inappropriate_caption", "spam_caption", "gibberish", "nsfw", "hate_speech", "off_topic"]),
  "reason": string (short human-readable explanation)
}`;

    const userPrompt = `Evaluate this POST:
${fullText || '(No text/caption provided, only media)'}
${images.length > 0 ? `Attached Image URLs: ${images.slice(0, 3).join(', ')}` : ''}`;

    return this.runAIModeration(systemPrompt, userPrompt, images);
  }

  /**
   * Evaluate standalone Caption or Name
   */
  async evaluateTextOrCaption(
    captionOrName: string,
    fieldType: 'caption' | 'name' | 'title' = 'caption',
  ): Promise<ModerationResult> {
    const systemPrompt = `You are an AI Content Moderator.
Evaluate this user-submitted ${fieldType.toUpperCase()} for validity, safety, and relevance.

Criteria:
1. isRelevant: Reject keyboard smash, gibberish (e.g. "asdfgh", "111111"), scam advertisements, or spam.
2. isSafe: Reject hate speech, slurs, profanity, harassment, sexual references, or illegal goods.

Respond strictly in valid JSON format:
{
  "isRelevant": boolean,
  "isSafe": boolean,
  "confidence": number (0.0 to 1.0),
  "flags": string[],
  "reason": string
}`;

    const userPrompt = `${fieldType.toUpperCase()} to evaluate: "${captionOrName}"`;
    return this.runAIModeration(systemPrompt, userPrompt, []);
  }

  /**
   * Evaluate a comment for relevance and safety
   */
  async evaluateComment(input: CommentModerationInput): Promise<ModerationResult> {
    const systemPrompt = `You are an AI Content Moderator for a social & marketplace platform.
Evaluate this user comment/reply.

Criteria:
1. isRelevant: Is the comment coherent text? (Reject gibberish spam, link dumps, bot scams).
2. isSafe: Is the comment free from hate speech, harassment, severe toxicity, threats, and NSFW/scam links?

Respond strictly in valid JSON format:
{
  "isRelevant": boolean,
  "isSafe": boolean,
  "confidence": number (0.0 to 1.0),
  "flags": string[],
  "reason": string
}`;

    const userPrompt = `Comment to evaluate: "${input.comment}"
${input.postText ? `Context (Post being commented on): "${input.postText}"` : ''}`;

    return this.runAIModeration(systemPrompt, userPrompt, []);
  }

  /**
   * Evaluate a marketplace product (Closet item or Ebook)
   */
  async evaluateProduct(input: ProductModerationInput): Promise<ModerationResult> {
    const images = (input.images || []).filter((img) => typeof img === 'string' && img.startsWith('http'));

    const systemPrompt = `You are an AI Content Moderator for a digital and physical marketplace.
Evaluate this listing (product or ebook) for relevance, integrity, and safety.

Criteria:
1. isRelevant: Is the item name and description coherent? (Reject gibberish titles like "aaaaa", random letters, or spam promotional links).
2. isSafe: Reject prohibited goods (weapons, drugs, counterfeit items, explicit adult products/pornography, scams).

Respond strictly in valid JSON format:
{
  "isRelevant": boolean,
  "isSafe": boolean,
  "confidence": number (0.0 to 1.0),
  "flags": string[],
  "reason": string
}`;

    const userPrompt = `Product Details:
Name: "${input.name}"
Category: "${input.category}"
Description: "${input.description || ''}"
Brand: "${input.brand || ''}"
Price: ${input.price ?? 'N/A'}
${images.length > 0 ? `Image URLs: ${images.slice(0, 3).join(', ')}` : ''}`;

    return this.runAIModeration(systemPrompt, userPrompt, images);
  }

  /**
   * Internal dispatcher for AI evaluation
   */
  private async runAIModeration(
    systemPrompt: string,
    userPrompt: string,
    imageUrls: string[] = [],
  ): Promise<ModerationResult> {
    try {
      if (this.provider === 'openai' && this.openaiApiKey) {
        const res = await this.runOpenAIModeration(systemPrompt, userPrompt, imageUrls);
        return this.formatVerdict(res, 'AI_OPENAI');
      }

      if (this.provider === 'gemini' && this.geminiApiKey) {
        const res = await this.runGeminiModeration(systemPrompt, userPrompt, imageUrls);
        return this.formatVerdict(res, 'AI_GEMINI');
      }

      if (this.openaiApiKey) {
        const res = await this.runOpenAIModeration(systemPrompt, userPrompt, imageUrls);
        return this.formatVerdict(res, 'AI_OPENAI');
      }

      if (this.geminiApiKey) {
        const res = await this.runGeminiModeration(systemPrompt, userPrompt, imageUrls);
        return this.formatVerdict(res, 'AI_GEMINI');
      }

      this.logger.warn('No valid AI moderation API key configured. Using local rule-based safety.');
      return this.runLocalRules(userPrompt);
    } catch (err: any) {
      this.logger.error(`AI Moderation request failed: ${err.message}`, err.stack);
      return this.runLocalRules(userPrompt);
    }
  }

  /**
   * Call Gemini 1.5 Flash API
   */
  private async runGeminiModeration(
    systemPrompt: string,
    userPrompt: string,
    imageUrls: string[] = [],
  ): Promise<AIModerationResponse> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.geminiApiKey}`;

    const parts: any[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];

    for (const url of imageUrls.slice(0, 2)) {
      try {
        const imgRes = await fetch(url);
        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
          parts.push({
            inline_data: {
              mime_type: mimeType,
              data: Buffer.from(buffer).toString('base64'),
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`Failed to fetch image for Gemini moderation: ${url}`);
      }
    }

    const body = {
      contents: [{ parts }],
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.1,
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) {
      throw new Error('Gemini API returned empty response content');
    }

    return JSON.parse(candidateText) as AIModerationResponse;
  }

  /**
   * Call OpenAI gpt-4o-mini API
   */
  private async runOpenAIModeration(
    systemPrompt: string,
    userPrompt: string,
    imageUrls: string[] = [],
  ): Promise<AIModerationResponse> {
    const endpoint = 'https://api.openai.com/v1/chat/completions';

    const contentArray: any[] = [{ type: 'text', text: userPrompt }];
    for (const url of imageUrls.slice(0, 2)) {
      contentArray.push({
        type: 'image_url',
        image_url: { url, detail: 'low' },
      });
    }

    const body = {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: contentArray },
      ],
      temperature: 0.1,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI API returned empty content');
    }

    return JSON.parse(content) as AIModerationResponse;
  }

  /**
   * Rule-based fallback when AI APIs are unavailable or not yet configured
   */
  private runLocalRules(userPrompt: string): ModerationResult {
    const text = userPrompt.toLowerCase();

    const repeatedLetters = /(.)\1{9,}/.test(text);
    const explicitBadWords = ['kill yourself', 'free money click here', 'telegram bot scam', 'crypto hack tool'];
    const hasBadPhrase = explicitBadWords.some((w) => text.includes(w));

    if (repeatedLetters || hasBadPhrase) {
      return {
        status: 'PENDING_APPROVAL',
        reason: hasBadPhrase
          ? 'Flagged by automated rule: prohibited terms detected'
          : 'Flagged by automated rule: repetitive characters/potential spam',
        score: 0.9,
        flaggedLabels: ['automated_rule_violation'],
        moderatedBy: 'SYSTEM_RULES_LOCAL',
      };
    }

    return {
      status: 'APPROVED',
      reason: 'Auto-approved (Clean)',
      score: 1.0,
      flaggedLabels: [],
      moderatedBy: 'SYSTEM_RULES_LOCAL',
    };
  }

  /**
   * Format AI response into standardized ModerationResult
   */
  private formatVerdict(aiRes: AIModerationResponse, provider: string): ModerationResult {
    const isApproved = aiRes.isRelevant === true && aiRes.isSafe === true;

    return {
      status: isApproved ? 'APPROVED' : 'PENDING_APPROVAL',
      reason: aiRes.reason || (isApproved ? 'Approved by AI' : 'Flagged for admin review'),
      score: aiRes.confidence || 0.9,
      flaggedLabels: aiRes.flags || [],
      moderatedBy: provider,
    };
  }
}
