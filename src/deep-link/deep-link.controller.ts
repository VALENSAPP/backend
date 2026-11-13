import {

  Body,

  Controller,

  Get,

  HttpException,

  Param,

  Post,

  Req,

  Res,

  ValidationPipe,

} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Request, Response } from 'express';

import { WebMissionDonateDto } from './dto/web-mission-donate.dto';

import { MissionSharePageData, MissionShareService } from './mission-share.service';



@ApiTags('Deep Links')

@Controller()

export class DeepLinkController {

  constructor(private readonly missionShareService: MissionShareService) {}



  private escapeHtml(value: string) {

    return value

      .replace(/&/g, '&amp;')

      .replace(/</g, '&lt;')

      .replace(/>/g, '&gt;')

      .replace(/"/g, '&quot;')

      .replace(/'/g, '&#39;');

  }



  private escapeJs(value: string) {

    return value

      .replace(/\\/g, '\\\\')

      .replace(/'/g, "\\'")

      .replace(/"/g, '\\"')

      .replace(/\n/g, '\\n')

      .replace(/\r/g, '\\r')

      .replace(/</g, '\\u003c')

      .replace(/>/g, '\\u003e');

  }



  private getAppStoreUrl() {

    return process.env.APP_STORE_URL || 'https://apps.apple.com/us/app/valens-app/id6752780902';

  }



  private getPlayStoreUrl() {

    return process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.valens';

  }



  /**

   * Android app manifest uses scheme "com.valens" (not com.valens.app).

   * Intent URLs with package=com.valens open the installed app;

   * browserFallbackUrl is used only if the app is missing.

   */

  private buildAndroidIntentUrl(schemePath: string, browserFallbackUrl: string, scheme = 'com.valens') {

    const encodedFallback = encodeURIComponent(browserFallbackUrl);

    const cleanPath = schemePath.replace(/^\/+/, '');

    return `intent://${cleanPath}#Intent;scheme=${scheme};package=com.valens;S.browser_fallback_url=${encodedFallback};end`;

  }



  private parseCustomSchemeUrl(deepLinkUrl: string): { scheme: string; path: string } {

    const match = deepLinkUrl.match(/^([a-z0-9.+-]+):\/\/(.*)$/i);

    if (!match) {

      return { scheme: 'com.valens', path: deepLinkUrl };

    }

    return { scheme: match[1], path: match[2] };

  }



  /**

   * Normal shares: try open app, then store.

   * Android → Intent with scheme com.valens (matches AndroidManifest).

   * iOS → custom scheme com.valens.app.

   */

  private openAppThenStoreScript(deepLinkUrl: string) {

    const { path } = this.parseCustomSchemeUrl(deepLinkUrl);

    const playStoreUrl = this.getPlayStoreUrl();

    // Android app only registers scheme "com.valens"

    const androidIntentUrl = this.buildAndroidIntentUrl(path, playStoreUrl, 'com.valens');

    const iosDeepLinkUrl = deepLinkUrl.replace(/^com\.valens:\/\//, 'com.valens.app://');

    // Ensure iOS uses com.valens.app even if caller passed com.valens

    const iosLink = iosDeepLinkUrl.startsWith('com.valens.app://')

      ? iosDeepLinkUrl

      : deepLinkUrl.includes('://')

        ? deepLinkUrl.replace(/^[^:]+:\/\//, 'com.valens.app://')

        : `com.valens.app://${deepLinkUrl}`;



    const safeIosDeepLink = this.escapeHtml(iosLink);

    const safeAndroidIntent = this.escapeHtml(androidIntentUrl);

    const safeAppStore = this.escapeHtml(this.getAppStoreUrl());

    const safePlayStore = this.escapeHtml(playStoreUrl);



    return `

      <script>

        (function () {

          var iosDeepLink = "${safeIosDeepLink}";

          var androidIntent = "${safeAndroidIntent}";

          var appStore = "${safeAppStore}";

          var playStore = "${safePlayStore}";



          function isAndroid() {

            return /Android/i.test(navigator.userAgent || '');

          }



          if (isAndroid()) {

            // Intent scheme=com.valens matches AndroidManifest; opens installed app.

            window.location.href = androidIntent;

            setTimeout(function () {

              if (document.hidden) return;

              window.location.href = playStore;

            }, 2500);

            return;

          }



          window.location.href = iosDeepLink;

          setTimeout(function () {

            if (document.hidden) return;

            window.location.href = appStore;

          }, 2000);

        })();

      </script>

    `;

  }



  private fallbackHtml(route: string, id: string, req: Request) {

    const configuredBaseUrl = process.env.BASE_URL;

    const configuredOgImageUrl = process.env.OG_IMAGE_URL;

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;

    const host = req.get('host');

    const baseUrl = configuredBaseUrl || (host ? `${protocol}://${host}` : 'https://api.valens.app');

    const encodedId = encodeURIComponent(id);

    const rawQuery = req.url && req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId.trim() : '';
    const querySuffix = rawQuery || (itemId ? `?itemId=${encodeURIComponent(itemId)}` : '');

    const shareUrl = `${baseUrl}/${route}/${encodedId}${querySuffix}`;

    const ogImage = configuredOgImageUrl || `${baseUrl}/share-assets/valens-share-og.png`;

    const deepLinkUrl = `com.valens.app://${route}/${encodedId}${querySuffix}`;

    const safeShareUrl = this.escapeHtml(shareUrl);

    const safeOgImage = this.escapeHtml(ogImage);



    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Valens App · Reputation Earned. Value Built</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="description" content="Reputation Earned. Value Built">

          <meta property="og:type" content="website">
          <meta property="og:site_name" content="Valens">
          <meta property="og:title" content="Valens App">
          <meta property="og:description" content="Reputation Earned. Value Built">
          <meta property="og:url" content="${safeShareUrl}">
          <meta property="og:image" content="${safeOgImage}">
          <meta property="og:image:secure_url" content="${safeOgImage}">
          <meta property="og:image:type" content="image/png">
          <meta property="og:image:width" content="1200">
          <meta property="og:image:height" content="630">
          <meta property="og:image:alt" content="Valens App">

          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="Valens App">
          <meta name="twitter:description" content="Reputation Earned. Value Built">
          <meta name="twitter:image" content="${safeOgImage}">

          <link rel="icon" type="image/png" href="${baseUrl}/logo.png">
          <link rel="apple-touch-icon" href="${baseUrl}/logo.png">
          <link rel="apple-touch-icon-precomposed" href="${baseUrl}/logo.png">
          <link rel="canonical" href="${safeShareUrl}">
        </head>
        <body>
          <p></p>
          ${this.openAppThenStoreScript(deepLinkUrl)}
        </body>
      </html>
    `;
  }

  private callbackFallbackHtml(req: Request) {
    const configuredBaseUrl = process.env.BASE_URL;
    const configuredOgImageUrl = process.env.OG_IMAGE_URL;
    const configuredHomeDeepLink = process.env.HOME_DEEP_LINK_URL;
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = req.get('host');
    const baseUrl = configuredBaseUrl || (host ? `${protocol}://${host}` : 'https://api.valens.app');
    const shareUrl = `${baseUrl}/callback`;
    const ogImage = configuredOgImageUrl || `${baseUrl}/share-assets/valens-share-og.png`;
    const deepLinkUrl = configuredHomeDeepLink || 'com.valens://callback';
    const safeShareUrl = this.escapeHtml(shareUrl);
    const safeOgImage = this.escapeHtml(ogImage);

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Valens App · Reputation Earned. Value Built</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="description" content="Reputation Earned. Value Built">

          <meta property="og:type" content="website">
          <meta property="og:site_name" content="Valens">
          <meta property="og:title" content="Valens App">
          <meta property="og:description" content="Reputation Earned. Value Built">
          <meta property="og:url" content="${safeShareUrl}">
          <meta property="og:image" content="${safeOgImage}">
          <meta property="og:image:secure_url" content="${safeOgImage}">
          <meta property="og:image:type" content="image/png">
          <meta property="og:image:width" content="1200">
          <meta property="og:image:height" content="630">
          <meta property="og:image:alt" content="Valens App">

          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:title" content="Valens App">
          <meta name="twitter:description" content="Reputation Earned. Value Built">
          <meta name="twitter:image" content="${safeOgImage}">

          <link rel="icon" type="image/png" href="${baseUrl}/logo.png">
          <link rel="apple-touch-icon" href="${baseUrl}/logo.png">
          <link rel="apple-touch-icon-precomposed" href="${baseUrl}/logo.png">
          <link rel="canonical" href="${safeShareUrl}">
        </head>
        <body>
          <p></p>
          ${this.openAppThenStoreScript(deepLinkUrl)}
        </body>
      </html>
    `;

  }



  private money(value: number) {

    return `$${Number(value || 0).toFixed(2)}`;

  }



  private missionDonationHtml(data: MissionSharePageData, req: Request) {

    const configuredBaseUrl = process.env.BASE_URL;

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;

    const host = req.get('host');

    const baseUrl = configuredBaseUrl || (host ? `${protocol}://${host}` : 'https://prod-api.valens.app');

    const shareUrl = `${baseUrl}/postshare/${encodeURIComponent(data.postId)}`;

    const deepLinkUrl = `com.valens.app://postshare/${encodeURIComponent(data.postId)}`;

    const appStoreUrl = this.getAppStoreUrl();

    const playStoreUrl = this.getPlayStoreUrl();

    // Donation: if app missing, come back to this webpage (not Play Store).

    // AndroidManifest scheme is "com.valens".

    const androidIntentUrl = this.buildAndroidIntentUrl(

      `postshare/${encodeURIComponent(data.postId)}`,

      shareUrl,

      'com.valens',

    );

    const ogImage = data.image || process.env.OG_IMAGE_URL || `${baseUrl}/share-assets/valens-share.png`;

    const description = `Support @${data.vendorHandle}'s mission on Valens. ${data.raisedAmount.toFixed(2)} raised of ${data.goalAmount.toFixed(2)} goal.`;



    const safeShareUrl = this.escapeHtml(shareUrl);

    const safeOgImage = this.escapeHtml(ogImage);

    const safeTitle = this.escapeHtml(data.title);

    const safeVendorName = this.escapeHtml(data.vendorName);

    const safeVendorHandle = this.escapeHtml(data.vendorHandle);

    const safeDescription = this.escapeHtml(description);

    const safeStatusMessage = this.escapeHtml(data.statusMessage);

    const safeImage = data.image ? this.escapeHtml(data.image) : '';

    const safeDeepLink = this.escapeJs(deepLinkUrl);

    const safeAndroidIntent = this.escapeJs(androidIntentUrl);

    const safeAppStore = this.escapeJs(appStoreUrl);

    const safePlayStore = this.escapeJs(playStoreUrl);

    const safePostId = this.escapeJs(data.postId);

    const remaining = this.money(data.remainingAmount);

    const raised = this.money(data.raisedAmount);

    const goal = this.money(data.goalAmount);

    const canDonate = data.canDonate;



    return `<!DOCTYPE html>

<html lang="en">

<head>

  <meta charset="utf-8">

  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>${safeTitle} · Valens</title>

  <meta name="description" content="${safeDescription}">

  <meta property="og:type" content="website">

  <meta property="og:site_name" content="Valens">

  <meta property="og:title" content="${this.escapeHtml(`Support @${data.vendorHandle}'s Mission on Valens`)}">

  <meta property="og:description" content="${safeDescription}">

  <meta property="og:url" content="${safeShareUrl}">

  <meta property="og:image" content="${safeOgImage}">

  <meta name="twitter:card" content="summary_large_image">

  <meta name="twitter:title" content="${this.escapeHtml(`Support @${data.vendorHandle}'s Mission on Valens`)}">

  <meta name="twitter:description" content="${safeDescription}">

  <meta name="twitter:image" content="${safeOgImage}">

  <link rel="canonical" href="${safeShareUrl}">

  <style>

    :root {

      --bg: #ffffff;

      --panel: #ffffff;

      --text: #111111;

      --muted: #666666;

      --line: rgba(0,0,0,0.12);

      --accent: #1f9e63;

      --accent-dark: #17804f;

      --danger: #d64545;

      --warn: #b8860b;

    }

    * { box-sizing: border-box; }

    body {

      margin: 0;

      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;

      background: #ffffff;

      color: var(--text);

      min-height: 100vh;

    }

    .wrap {

      width: min(560px, 100%);

      margin: 0 auto;

      padding: 24px 16px 48px;

    }

    .brand {

      display: flex;

      align-items: center;

      justify-content: space-between;

      margin-bottom: 18px;

      gap: 12px;

    }

    .brand strong { letter-spacing: 0.08em; font-size: 14px; color: #111111; }

    .open-app {

      color: var(--accent);

      text-decoration: none;

      font-size: 13px;

      font-weight: 600;

    }

    .card {

      background: #ffffff;

      border: 1px solid var(--line);

      border-radius: 24px;

      overflow: hidden;

      box-shadow: 0 10px 30px rgba(0,0,0,0.08);

    }

    .hero-frame {

      width: 100%;

      aspect-ratio: 16 / 10;

      background: #f0f0f0;

      overflow: hidden;

      position: relative;

    }

    .hero {

      width: 100%;

      height: 100%;

      object-fit: contain;

      object-position: center;

      display: block;

      background: #f0f0f0;

    }

    .hero.hero-cover { object-fit: cover; }

    .hero.hero-contain { object-fit: contain; }

    .hero-fallback {

      width: 100%;

      aspect-ratio: 16 / 10;

      display: grid;

      place-items: center;

      background: #f5f5f5;

      color: var(--muted);

      font-size: 14px;

    }

    .content { padding: 22px 20px 24px; }

    .creator {

      display: flex;

      align-items: center;

      gap: 12px;

      margin-bottom: 14px;

    }

    .avatar {

      width: 44px;

      height: 44px;

      border-radius: 50%;

      object-fit: cover;

      background: #e8e8e8;

    }

    .creator h2 {

      margin: 0;

      font-size: 16px;

      color: #111111;

    }

    .creator p {

      margin: 2px 0 0;

      color: var(--muted);

      font-size: 13px;

    }

    h1 {

      margin: 0 0 10px;

      font-size: 26px;

      line-height: 1.25;

      color: #111111;

    }

    .status {

      margin: 0 0 18px;

      color: var(--muted);

      font-size: 14px;

      line-height: 1.5;

    }

    .status.goal_reached { color: var(--accent); }

    .status.closed, .status.unavailable { color: var(--danger); }

    .status.not_started { color: var(--warn); }

    .stats {

      display: grid;

      grid-template-columns: repeat(3, 1fr);

      gap: 10px;

      margin-bottom: 14px;

    }

    .stat {

      background: #f7f7f7;

      border: 1px solid var(--line);

      border-radius: 14px;

      padding: 12px 10px;

      text-align: center;

    }

    .stat span {

      display: block;

      color: var(--muted);

      font-size: 11px;

      margin-bottom: 6px;

      text-transform: uppercase;

      letter-spacing: 0.04em;

    }

    .stat strong { font-size: 15px; color: #111111; }

    .progress {

      height: 10px;

      border-radius: 999px;

      background: #ececec;

      overflow: hidden;

      margin-bottom: 8px;

    }

    .progress > i {

      display: block;

      height: 100%;

      width: ${Math.max(0, Math.min(100, data.fundedPercent))}%;

      background: linear-gradient(90deg, var(--accent-dark), var(--accent));

    }

    .progress-label {

      color: var(--muted);

      font-size: 12px;

      margin-bottom: 20px;

    }

    .form label {

      display: block;

      font-size: 13px;

      color: var(--muted);

      margin-bottom: 8px;

    }

    .presets {

      display: grid;

      grid-template-columns: repeat(4, 1fr);

      gap: 8px;

      margin-bottom: 12px;

    }

    .presets button {

      border: 1px solid var(--line);

      background: #ffffff;

      color: var(--text);

      border-radius: 12px;

      padding: 10px 0;

      cursor: pointer;

      font-weight: 600;

    }

    .presets button.active {

      border-color: var(--accent);

      background: rgba(31,158,99,0.1);

      color: var(--accent);

    }

    input, textarea {

      width: 100%;

      border-radius: 14px;

      border: 1px solid var(--line);

      background: #ffffff;

      color: var(--text);

      padding: 14px 14px;

      font-size: 16px;

      margin-bottom: 12px;

      outline: none;

    }

    input:focus, textarea:focus { border-color: rgba(31,158,99,0.65); }

    textarea { min-height: 88px; resize: vertical; }

    .donate-btn, .disabled-btn {

      width: 100%;

      border: 0;

      border-radius: 14px;

      padding: 15px 16px;

      font-size: 16px;

      font-weight: 700;

      cursor: pointer;

    }

    .donate-btn {

      background: linear-gradient(180deg, #49d897, #2fb574);

      color: #062315;

    }

    .donate-btn:disabled {

      opacity: 0.65;

      cursor: wait;

    }

    .disabled-btn {

      background: #f0f0f0;

      color: var(--muted);

      cursor: not-allowed;

    }

    .error {

      display: none;

      margin-top: 12px;

      color: var(--danger);

      font-size: 13px;

      line-height: 1.4;

    }

    .hint {

      margin-top: 14px;

      color: var(--muted);

      font-size: 12px;

      text-align: center;

      line-height: 1.5;

    }

  </style>

</head>

<body>

  <div class="wrap">

    <div class="brand">

      <strong>VALENS</strong>

      <a class="open-app" id="openAppLink" href="#">Open in app</a>

    </div>

    <div class="card">

      ${

        safeImage

          ? `<div class="hero-frame"><img class="hero" id="heroImage" src="${safeImage}" alt="${safeTitle}"></div>`

          : `<div class="hero-fallback">Mission on Valens</div>`

      }

      <div class="content">

        <div class="creator">

          ${

            data.vendorImage

              ? `<img class="avatar" src="${this.escapeHtml(data.vendorImage)}" alt="${safeVendorName}">`

              : `<div class="avatar"></div>`

          }

          <div>

            <h2>${safeVendorName}</h2>

            <p>@${safeVendorHandle}</p>

          </div>

        </div>

        <h1>${safeTitle}</h1>

        <p class="status ${this.escapeHtml(data.status)}">${safeStatusMessage}</p>

        <div class="stats">

          <div class="stat"><span>Raised</span><strong>${raised}</strong></div>

          <div class="stat"><span>Goal</span><strong>${goal}</strong></div>

          <div class="stat"><span>Left</span><strong>${remaining}</strong></div>

        </div>

        <div class="progress"><i></i></div>

        <div class="progress-label">${data.fundedPercent}% funded</div>

        ${

          canDonate

            ? `<form class="form" id="donateForm">

                <label for="amount">Donation amount (USD)</label>

                <div class="presets">

                  <button type="button" data-amount="5">$5</button>

                  <button type="button" data-amount="10" class="active">$10</button>

                  <button type="button" data-amount="25">$25</button>

                  <button type="button" data-amount="50">$50</button>

                </div>

                <input id="amount" name="amount" type="number" min="0.01" step="0.01" value="10" required>

                <label for="note">Note (optional)</label>

                <textarea id="note" name="note" placeholder="Leave a message of support"></textarea>

                <button class="donate-btn" id="donateBtn" type="submit">Donate securely</button>

                <div class="error" id="errorBox"></div>

                <p class="hint">Secure checkout powered by Stripe. Remaining goal: ${remaining}.</p>

              </form>`

            : `<button class="disabled-btn" type="button" disabled>${safeStatusMessage}</button>

               <p class="hint">Open the Valens app to follow this mission.</p>`

        }

      </div>

    </div>

  </div>

  <script>

    (function () {

      var deepLink = "${safeDeepLink}";

      var androidIntent = "${safeAndroidIntent}";

      var appStore = "${safeAppStore}";

      var playStore = "${safePlayStore}";

      var postId = "${safePostId}";

      var canDonate = ${canDonate ? 'true' : 'false'};

      var remaining = ${Number(data.remainingAmount || 0)};



      function isAndroid() {

        return /Android/i.test(navigator.userAgent || '');

      }



      function openAppLinkTarget() {

        // AndroidManifest: scheme com.valens. iOS: com.valens.app.

        return isAndroid() ? androidIntent : deepLink;

      }



      function applyHeroResizeMode(img) {

        if (!img || !img.naturalWidth || !img.naturalHeight) return;

        var imageRatio = img.naturalWidth / img.naturalHeight;

        var frame = img.parentElement;

        var frameRatio = frame && frame.clientWidth && frame.clientHeight

          ? frame.clientWidth / frame.clientHeight

          : 16 / 10;

        var diff = Math.abs(imageRatio - frameRatio) / frameRatio;



        img.classList.remove('hero-cover', 'hero-contain');



        // Portrait or strongly mismatched aspect → show full image (contain)

        // Close to frame aspect → fill frame (cover)

        if (imageRatio < 0.95 || diff > 0.28) {

          img.classList.add('hero-contain');

          img.style.objectFit = 'contain';

        } else {

          img.classList.add('hero-cover');

          img.style.objectFit = 'cover';

        }

      }



      var heroImage = document.getElementById('heroImage');

      if (heroImage) {

        if (heroImage.complete && heroImage.naturalWidth) {

          applyHeroResizeMode(heroImage);

        } else {

          heroImage.addEventListener('load', function () {

            applyHeroResizeMode(heroImage);

          });

        }

        window.addEventListener('resize', function () {

          applyHeroResizeMode(heroImage);

        });

      }



      function tryOpenApp() {

        // Donation: try open app once. If missing, Intent falls back to this webpage (not Play Store).

        var triedKey = 'valens_open_tried:' + location.pathname;

        try {

          if (sessionStorage.getItem(triedKey) === '1') return;

          sessionStorage.setItem(triedKey, '1');

        } catch (e) {}

        window.location.href = openAppLinkTarget();

      }



      var openAppLink = document.getElementById('openAppLink');

      if (openAppLink) {

        openAppLink.addEventListener('click', function (e) {

          e.preventDefault();

          window.location.href = openAppLinkTarget();

          setTimeout(function () {

            if (!document.hidden) {

              window.location.href = isAndroid() ? playStore : appStore;

            }

          }, 1800);

        });

      }



      tryOpenApp();



      if (!canDonate) return;



      var form = document.getElementById('donateForm');

      var amountInput = document.getElementById('amount');

      var noteInput = document.getElementById('note');

      var donateBtn = document.getElementById('donateBtn');

      var errorBox = document.getElementById('errorBox');

      var presetButtons = document.querySelectorAll('.presets button');



      presetButtons.forEach(function (btn) {

        btn.addEventListener('click', function () {

          presetButtons.forEach(function (b) { b.classList.remove('active'); });

          btn.classList.add('active');

          amountInput.value = btn.getAttribute('data-amount');

        });

      });



      form.addEventListener('submit', async function (e) {

        e.preventDefault();

        errorBox.style.display = 'none';

        errorBox.textContent = '';



        var amount = Number(amountInput.value);

        if (!amount || amount < 0.01) {

          errorBox.textContent = 'Enter a valid donation amount.';

          errorBox.style.display = 'block';

          return;

        }

        if (remaining > 0 && amount > remaining + 0.0001) {

          errorBox.textContent = 'Donation exceeds remaining goal amount of $' + remaining.toFixed(2) + '.';

          errorBox.style.display = 'block';

          return;

        }



        donateBtn.disabled = true;

        donateBtn.textContent = 'Redirecting to checkout...';



        try {

          var response = await fetch('/postshare/' + encodeURIComponent(postId) + '/donate', {

            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({

              amount: amount,

              note: (noteInput.value || '').trim() || undefined

            })

          });

          var payload = await response.json();

          var sessionUrl =

            (payload && payload.data && payload.data.sessionUrl) ||

            (payload && payload.sessionUrl);



          if (!response.ok || !sessionUrl) {

            var message =

              (payload && payload.message) ||

              (payload && payload.data && payload.data.message) ||

              'Unable to start checkout. Please try again.';

            if (Array.isArray(message)) message = message.join(', ');

            throw new Error(message);

          }



          window.location.href = sessionUrl;

        } catch (err) {

          errorBox.textContent = (err && err.message) ? err.message : 'Unable to start checkout.';

          errorBox.style.display = 'block';

          donateBtn.disabled = false;

          donateBtn.textContent = 'Donate securely';

        }

      });

    })();

  </script>

</body>

</html>`;

  }



  @Get('callback')

  callback(@Req() req: Request, @Res() res: Response) {

    return res.send(this.callbackFallbackHtml(req));

  }



  @Get('profile/:id')

  profile(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('profile', id, req));

  }



  @Get('u/:id')

  user(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('u', id, req));

  }



  @Get('share/:id')

  share(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('share', id, req));

  }



  @Get('postshare/:id')

  async postshare(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    try {

      const missionData = await this.missionShareService.getMissionSharePageData(id);

      if (missionData) {

        res.setHeader('Content-Type', 'text/html; charset=utf-8');

        return res.send(this.missionDonationHtml(missionData, req));

      }

    } catch (error) {

      // Non-mission or missing post falls back to default deep-link page.

    }



    return res.send(this.fallbackHtml('postshare', id, req));

  }



  @Post('postshare/:id/donate')

  @ApiOperation({

    summary: 'Create Stripe checkout for a shared mission post (public web page)',

  })

  async donateFromSharePage(

    @Param('id') id: string,

    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: WebMissionDonateDto,

  ) {

    try {

      const donation = await this.missionShareService.createWebDonation(id, dto.amount, dto.note);

      return {

        sessionUrl: donation.sessionUrl,

        donationId: donation.id,

        status: donation.status,

        remainingHint: true,

      };

    } catch (error) {

      if (error instanceof HttpException) {

        throw error;

      }

      throw error;

    }

  }



  @Get('reelshare/:id')

  reelshare(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('reelshare', id, req));

  }



  @Get('storyshare/:id')

  storyshare(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('storyshare', id, req));

  }



  @Get('closet/:id')

  closet(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {

    return res.send(this.fallbackHtml('closet', id, req));

  }

}

