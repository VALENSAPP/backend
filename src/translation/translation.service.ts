import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  cached: boolean;
  provider?: string;
}

export interface PostTranslationResult {
  postId: string;
  originalCaption?: string | null;
  translatedCaption?: string | null;
  originalText?: string | null;
  translatedText?: string | null;
  targetLang: string;
  cached: boolean;
}

export interface UserBioTranslationResult {
  userId: string;
  displayName?: string | null;
  userName?: string | null;
  originalBio?: string | null;
  translatedBio?: string | null;
  targetLang: string;
  cached: boolean;
}

interface CacheEntry {
  translatedText: string;
  sourceLang: string;
  expiresAt: number;
}

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);
  private readonly geminiApiKey?: string;
  private readonly openaiApiKey?: string;

  // In-memory cache: key -> CacheEntry
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly MAX_CACHE_ENTRIES = 10000;

  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.geminiApiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY;
    this.openaiApiKey =
      this.configService.get<string>('OPENAI_API_KEY') ||
      process.env.OPENAI_API_KEY;
  }

  /**
   * Normalize language code (e.g. 'pt-BR' -> 'pt', 'en-US' -> 'en', 'spanish' -> 'es')
   */
  normalizeLanguage(lang?: string): string {
    if (!lang || typeof lang !== 'string') return 'pt';
    const clean = lang.trim().toLowerCase();
    if (clean.startsWith('pt')) return 'pt';
    if (clean.startsWith('es')) return 'es';
    if (clean.startsWith('it')) return 'it';
    if (clean.startsWith('fr')) return 'fr';
    if (clean.startsWith('en')) return 'en';
    if (clean.startsWith('de')) return 'de';
    if (clean.startsWith('ja')) return 'ja';
    if (clean.startsWith('zh')) return 'zh';
    if (clean.startsWith('ar')) return 'ar';
    if (clean.startsWith('ru')) return 'ru';
    return clean.slice(0, 2);
  }

  /**
   * Translates arbitrary text with in-memory caching and resilient multi-provider fallback.
   */
  async translateText(
    text: string,
    targetLang: string = 'pt',
    sourceLang?: string,
  ): Promise<TranslationResult> {
    if (!text || typeof text !== 'string' || text.trim() === '') {
      return {
        originalText: text || '',
        translatedText: text || '',
        sourceLang: sourceLang || 'unknown',
        targetLang: this.normalizeLanguage(targetLang),
        cached: false,
      };
    }

    const trimmedText = text.trim();
    const normalizedTarget = this.normalizeLanguage(targetLang);
    const normalizedSource = sourceLang ? this.normalizeLanguage(sourceLang) : 'auto';

    // If source and target are the same language, no translation needed
    if (normalizedSource !== 'auto' && normalizedSource === normalizedTarget) {
      return {
        originalText: trimmedText,
        translatedText: trimmedText,
        sourceLang: normalizedSource,
        targetLang: normalizedTarget,
        cached: false,
      };
    }

    // Check cache
    const cacheKey = this.getCacheKey(trimmedText, normalizedTarget, normalizedSource);
    const cachedEntry = this.getFromCache(cacheKey);
    if (cachedEntry) {
      this.cacheHits++;
      return {
        originalText: trimmedText,
        translatedText: cachedEntry.translatedText,
        sourceLang: cachedEntry.sourceLang,
        targetLang: normalizedTarget,
        cached: true,
      };
    }

    this.cacheMisses++;

    // Translate via Provider Hierarchy: Gemini -> OpenAI -> Fallback Public API
    let translated = '';
    let detectedSource = normalizedSource === 'auto' ? 'en' : normalizedSource;
    let providerUsed = 'unknown';

    // 1. Try Gemini
    if (this.geminiApiKey) {
      try {
        const geminiRes = await this.translateWithGemini(trimmedText, normalizedTarget, normalizedSource);
        if (geminiRes?.translatedText) {
          translated = geminiRes.translatedText;
          detectedSource = geminiRes.detectedSource || detectedSource;
          providerUsed = 'gemini';
        }
      } catch (err: any) {
        this.logger.warn(`Gemini translation failed: ${err.message}. Falling back to next provider.`);
      }
    }

    // 2. Try OpenAI
    if (!translated && this.openaiApiKey) {
      try {
        const openaiRes = await this.translateWithOpenAI(trimmedText, normalizedTarget, normalizedSource);
        if (openaiRes?.translatedText) {
          translated = openaiRes.translatedText;
          detectedSource = openaiRes.detectedSource || detectedSource;
          providerUsed = 'openai';
        }
      } catch (err: any) {
        this.logger.warn(`OpenAI translation failed: ${err.message}. Falling back to next provider.`);
      }
    }

    // 3. Try Fallback Public Translation API
    if (!translated) {
      try {
        const fallbackRes = await this.translateWithFallbackApi(trimmedText, normalizedTarget, detectedSource);
        if (fallbackRes) {
          translated = fallbackRes;
          providerUsed = 'fallback-api';
        }
      } catch (err: any) {
        this.logger.error(`Fallback translation API also failed: ${err.message}`);
      }
    }

    // If all providers failed, safely return original text without crashing
    if (!translated) {
      translated = trimmedText;
      providerUsed = 'none';
    }

    // Save to Cache
    this.saveToCache(cacheKey, {
      translatedText: translated,
      sourceLang: detectedSource,
      expiresAt: Date.now() + this.CACHE_TTL_MS,
    });

    return {
      originalText: trimmedText,
      translatedText: translated,
      sourceLang: detectedSource,
      targetLang: normalizedTarget,
      cached: false,
      provider: providerUsed,
    };
  }

  /**
   * On-Demand Translation for Post Caption & Text
   */
  async translatePost(postId: string, targetLang: string = 'pt'): Promise<PostTranslationResult> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, caption: true, text: true },
    });

    if (!post) {
      throw new NotFoundException(`Post with ID ${postId} not found`);
    }

    let translatedCaption: string | null = null;
    let translatedText: string | null = null;
    let wasCached = true;

    if (post.caption && post.caption.trim()) {
      const res = await this.translateText(post.caption, targetLang);
      translatedCaption = res.translatedText;
      if (!res.cached) wasCached = false;
    }

    if (post.text && post.text.trim()) {
      const res = await this.translateText(post.text, targetLang);
      translatedText = res.translatedText;
      if (!res.cached) wasCached = false;
    }

    return {
      postId: post.id,
      originalCaption: post.caption,
      translatedCaption,
      originalText: post.text,
      translatedText,
      targetLang: this.normalizeLanguage(targetLang),
      cached: wasCached,
    };
  }

  /**
   * On-Demand Translation for User Profile Bio
   */
  async translateUserBio(userId: string, targetLang: string = 'pt'): Promise<UserBioTranslationResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, userName: true, bio: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    let translatedBio: string | null = null;
    let wasCached = true;

    if (user.bio && user.bio.trim()) {
      const res = await this.translateText(user.bio, targetLang);
      translatedBio = res.translatedText;
      wasCached = res.cached;
    }

    return {
      userId: user.id,
      displayName: user.displayName,
      userName: user.userName,
      originalBio: user.bio,
      translatedBio,
      targetLang: this.normalizeLanguage(targetLang),
      cached: wasCached,
    };
  }

  /**
   * On-Demand Translation for Post Comment
   */
  async translateComment(commentId: string, targetLang: string = 'pt') {
    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, comment: true, postId: true, userId: true },
    });

    if (!comment) {
      throw new NotFoundException(`Comment with ID ${commentId} not found`);
    }

    const res = await this.translateText(comment.comment, targetLang);

    return {
      commentId: comment.id,
      postId: comment.postId,
      userId: comment.userId,
      originalComment: comment.comment,
      translatedComment: res.translatedText,
      targetLang: res.targetLang,
      sourceLang: res.sourceLang,
      cached: res.cached,
    };
  }

  /**
   * On-Demand Translation for Story Caption
   */
  async translateStory(storyId: string, targetLang: string = 'pt') {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      select: { id: true, caption: true, userId: true },
    });

    if (!story) {
      throw new NotFoundException(`Story with ID ${storyId} not found`);
    }

    let translatedCaption: string | null = null;
    let wasCached = true;

    if (story.caption && story.caption.trim()) {
      const res = await this.translateText(story.caption, targetLang);
      translatedCaption = res.translatedText;
      wasCached = res.cached;
    }

    return {
      storyId: story.id,
      userId: story.userId,
      originalCaption: story.caption,
      translatedCaption,
      targetLang: this.normalizeLanguage(targetLang),
      cached: wasCached,
    };
  }

  /**
   * Provider 1: Translate using Google Gemini API
   */
  private async translateWithGemini(
    text: string,
    targetLang: string,
    sourceLang: string = 'auto',
  ): Promise<{ translatedText: string; detectedSource?: string }> {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.geminiApiKey}`;

    const langNameMap: Record<string, string> = {
      pt: 'Portuguese (Português)',
      es: 'Spanish (Español)',
      it: 'Italian (Italiano)',
      fr: 'French (Français)',
      en: 'English',
      de: 'German (Deutsch)',
      ja: 'Japanese (日本語)',
      zh: 'Chinese (中文)',
      ru: 'Russian (Русский)',
      ar: 'Arabic (العربية)',
    };

    const targetLangName = langNameMap[targetLang] || targetLang;

    const systemPrompt = `You are a professional social media and UGC translator for the Valens platform.
Translate the user text into natural, fluent ${targetLangName}.
Guidelines:
1. Preserve all emojis (e.g. 🗽, 🔥, ❤️), hashtags (e.g. #summer, #crypto), @mentions, URLs, and formatting.
2. Maintain natural colloquial phrasing and tone appropriate for social media captions and profile bios.
3. If the input is already in ${targetLangName}, return it as is.
4. Respond strictly in valid JSON format: {"translatedText": "string", "detectedSource": "string"}`;

    const body = {
      contents: [
        {
          parts: [
            { text: `${systemPrompt}\n\nText to translate:\n"${text}"` },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
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
      throw new Error(`Gemini status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('Gemini returned empty response');
    }

    const parsed = JSON.parse(rawText);
    return {
      translatedText: parsed.translatedText || text,
      detectedSource: parsed.detectedSource,
    };
  }

  /**
   * Provider 2: Translate using OpenAI GPT-4o-mini
   */
  private async translateWithOpenAI(
    text: string,
    targetLang: string,
    sourceLang: string = 'auto',
  ): Promise<{ translatedText: string; detectedSource?: string }> {
    const endpoint = 'https://api.openai.com/v1/chat/completions';

    const systemPrompt = `You are a professional social media content translator.
Translate the text into natural ${targetLang}.
Preserve emojis, hashtags, @mentions, and formatting.
Respond in JSON format: {"translatedText": "string", "detectedSource": "string"}`;

    const body = {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
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
      throw new Error(`OpenAI status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty response');
    }

    const parsed = JSON.parse(content);
    return {
      translatedText: parsed.translatedText || text,
      detectedSource: parsed.detectedSource,
    };
  }

  /**
   * Provider 3: Fallback Public Translation REST API (MyMemory)
   */
  private async translateWithFallbackApi(
    text: string,
    targetLang: string,
    sourceLang: string = 'en',
  ): Promise<string | null> {
    const pair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    if (data?.responseData?.translatedText) {
      return data.responseData.translatedText;
    }
    return null;
  }

  // --- Caching Helpers ---

  private getCacheKey(text: string, targetLang: string, sourceLang: string): string {
    const hash = crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
    return `${targetLang}:${sourceLang}:${hash}`;
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  private saveToCache(key: string, entry: CacheEntry): void {
    // Evict oldest items if limit reached
    if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, entry);
  }

  /**
   * Cache diagnostics
   */
  getCacheStats() {
    return {
      totalCachedEntries: this.cache.size,
      maxEntries: this.MAX_CACHE_ENTRIES,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      hitRatio:
        this.cacheHits + this.cacheMisses > 0
          ? `${((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100).toFixed(1)}%`
          : '0%',
      ttlDays: this.CACHE_TTL_MS / (24 * 60 * 60 * 1000),
    };
  }

  /**
   * Clear in-memory translation cache
   */
  clearCache() {
    const previousSize = this.cache.size;
    this.cache.clear();
    return { message: `Translation cache cleared (${previousSize} entries removed)` };
  }
}
