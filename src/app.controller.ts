import { Controller, Get, Header, Req, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) { }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('logo.png')
  @Get('apple-touch-icon.png')
  @Get('apple-touch-icon-precomposed.png')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=86400')
  getLogo(@Res() res: Response) {
    const candidatePaths = [
      path.join(process.cwd(), 'public', 'logo.png'),
      path.join(process.cwd(), 'coin_backend', 'public', 'logo.png'),
      path.join(__dirname, '..', 'public', 'logo.png'),
      path.join(process.cwd(), 'public', 'images', 'logo.png'),
    ];
    const filePath = candidatePaths.find((p) => fs.existsSync(p));
    if (filePath) {
      return res.sendFile(filePath);
    }
    return res.status(404).send('Logo not found');
  }

  @Get('share-assets/valens-share-og.png')
  @Get('share-assets/valens-share.png')
  @Get('share-assets/valens-welcome-banner.png')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=86400')
  getShareBanner(@Res() res: Response) {
    const candidatePaths = [
      path.join(process.cwd(), 'public', 'share-assets', 'valens-share-og.png'),
      path.join(process.cwd(), 'coin_backend', 'public', 'share-assets', 'valens-share-og.png'),
      path.join(__dirname, '..', 'public', 'share-assets', 'valens-share-og.png'),
      path.join(process.cwd(), 'public', 'share-assets', 'valens-share.png'),
      path.join(process.cwd(), 'coin_backend', 'public', 'share-assets', 'valens-share.png'),
      path.join(__dirname, '..', 'public', 'share-assets', 'valens-share.png'),
      path.join(process.cwd(), 'public', 'share-assets', 'valens-welcome-banner.png'),
      path.join(process.cwd(), 'coin_backend', 'public', 'share-assets', 'valens-welcome-banner.png'),
      path.join(__dirname, '..', 'public', 'share-assets', 'valens-welcome-banner.png'),
    ];
    const filePath = candidatePaths.find((p) => fs.existsSync(p));
    if (filePath) {
      return res.sendFile(filePath);
    }
    return res.status(404).send('Banner not found');
  }

  @Get('.well-known/apple-app-site-association')
  @Get('well-known/apple-app-site-association')
  @Header('Content-Type', 'application/json')
  getAppleAppSiteAssociation(@Res() res: Response) {
    try {
      const candidatePaths = [
        path.join(process.cwd(), 'public', '.well-known', 'apple-app-site-association'),
        path.join(process.cwd(), 'coin_backend', 'public', '.well-known', 'apple-app-site-association'),
        path.join(__dirname, '..', 'public', '.well-known', 'apple-app-site-association'),
      ];
      const filePath = candidatePaths.find((p) => fs.existsSync(p));

      if (!filePath) {
        return res.status(404).json({
          message: 'Apple App Site Association file not found',
          error: 'Not Found',
          statusCode: 404,
        });
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return res.json(JSON.parse(content));
    } catch (error) {
      return res.status(500).json({
        message: 'Error reading Apple App Site Association file',
        error: 'Internal Server Error',
        statusCode: 500,
        details: error.message,
      });
    }
  }

  @Get('.well-known/assetlinks.json')
  @Get('well-known/assetlinks.json')
  @Header('Content-Type', 'application/json')
  getAssetLinks(@Res() res: Response) {
    try {
      const candidatePaths = [
        path.join(process.cwd(), 'public', '.well-known', 'assetlinks.json'),
        path.join(process.cwd(), 'coin_backend', 'public', '.well-known', 'assetlinks.json'),
        path.join(__dirname, '..', 'public', '.well-known', 'assetlinks.json'),
      ];
      const filePath = candidatePaths.find((p) => fs.existsSync(p));

      if (!filePath) {
        return res.status(404).json({
          message: 'Assetlinks file not found',
          error: 'Not Found',
          statusCode: 404,
        });
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return res.json(JSON.parse(content));
    } catch (error) {
      return res.status(500).json({
        message: 'Error reading Assetlinks file',
        error: 'Internal Server Error',
        statusCode: 500,
        details: error.message,
      });
    }
  }

  private escapeHtml(value: string): string {
    return (value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  @Get('open-app')
  @Get('app')
  @Get('open')
  @Get('share/app')
  @Get('share-app')
  @Get('download')
  @Get('invite')
  @Get('profile/:id')
  @Get('u/:id')
  openApp(@Req() req: Request, @Res() res: Response) {
    const configuredBaseUrl = process.env.BASE_URL;
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = req.get('host');
    const baseUrl = configuredBaseUrl || (host ? `${protocol}://${host}` : 'https://prod-api.valens.app');

    const configuredOgImageUrl = process.env.OG_IMAGE_URL;
    const ogImage =
      configuredOgImageUrl ||
      `${baseUrl}/share-assets/valens-share-og.png`;

    const appStoreUrl =
      process.env.APP_STORE_URL || 'https://apps.apple.com/us/app/valens-app/id6752780902';
    const playStoreUrl =
      process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.valens';
    const webUrl =
      process.env.WEB_URL || process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://www.valenscorp.com';

    const logoUrl =
      process.env.APP_LOGO_URL ||
      `${baseUrl}/logo.png`;

    let rawPath = 'home';
    if (typeof req.query.path === 'string' && req.query.path.trim()) {
      rawPath = req.query.path.replace(/^\/+/, '');
    } else if (req.params && (req.params as any).id) {
      const isU = req.path.includes('/u/');
      rawPath = `${isU ? 'u' : 'profile'}/${(req.params as any).id}`;
      if (req.query && req.query.renew === 'true') {
        rawPath += '?renew=true';
      }
    }

    const shareUrl = `${baseUrl}/app${rawPath && rawPath !== 'home' ? `?path=${encodeURIComponent(rawPath)}` : ''}`;

    const title = 'Valens';
    const description = 'Reputation Earned. Value Built';

    const safeTitle = this.escapeHtml(title);
    const safeDesc = this.escapeHtml(description);
    const safeOgImage = this.escapeHtml(ogImage);
    const safeLogo = this.escapeHtml(logoUrl);
    const safeShareUrl = this.escapeHtml(shareUrl);
    const safeAppStore = this.escapeHtml(appStoreUrl);
    const safePlayStore = this.escapeHtml(playStoreUrl);
    const safeWebUrl = this.escapeHtml(webUrl);
    const safePath = this.escapeHtml(rawPath);

    const packageMatch = playStoreUrl.match(/id=([a-zA-Z0-9._]+)/);
    const packageId = packageMatch ? packageMatch[1] : 'com.valens';
    const safePackageId = this.escapeHtml(packageId);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} · Reputation Earned. Value Built</title>
  <meta name="description" content="${safeDesc}">

  <!-- Open Graph / WhatsApp / iMessage / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Valens">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:url" content="${safeShareUrl}">
  <meta property="og:image" content="${safeOgImage}">
  <meta property="og:image:secure_url" content="${safeOgImage}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="473">
  <meta property="og:image:height" content="1024">
  <meta property="og:image:alt" content="Valens App">

  <!-- Twitter / X -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeOgImage}">

  <link rel="icon" type="image/png" href="${baseUrl}/logo.png">
  <link rel="apple-touch-icon" href="${baseUrl}/logo.png">
  <link rel="apple-touch-icon-precomposed" href="${baseUrl}/logo.png">
  <link rel="canonical" href="${safeShareUrl}">

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0d0618;
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
    }
    .redirect-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
    }
    .logo {
      width: 80px;
      height: 80px;
      object-fit: contain;
      filter: drop-shadow(0 0 16px rgba(139, 92, 246, 0.4));
      animation: pulse 1.6s ease-in-out infinite alternate;
    }
    @keyframes pulse {
      0% { transform: scale(0.96); opacity: 0.85; }
      100% { transform: scale(1.04); opacity: 1; }
    }
    .spinner {
      width: 28px;
      height: 28px;
      border: 3px solid rgba(255, 255, 255, 0.15);
      border-top-color: #8b5cf6;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text {
      font-size: 15px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.85);
      letter-spacing: 0.2px;
    }
    .fallback-link {
      margin-top: 18px;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.5);
      opacity: 0;
      transition: opacity 0.4s ease;
    }
    .fallback-link a {
      color: #a78bfa;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="redirect-box">
    <img src="${safeLogo}" alt="Valens" class="logo">
    <div class="spinner"></div>
    <div class="status-text" id="status-text">Opening Valens...</div>
    <p class="fallback-link" id="fallback-container">
      Taking longer than expected? <a id="fallback-link" href="#">Click here</a>
    </p>
  </div>

  <script>
    (function () {
      var path = "${safePath}";
      var appStore = "${safeAppStore}";
      var playStore = "${safePlayStore}";
      var webUrl = "${safeWebUrl}";
      var packageId = "${safePackageId}";

      var ua = (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase();
      var isCrawler = /whatsapp|facebookexternalhit|twitterbot|telegrambot|applebot|discordbot|slackbot|linkedinbot/i.test(ua);
      if (isCrawler) {
        return;
      }

      var isIOS = /ipad|iphone|ipod/.test(ua) && !window.MSStream;
      var isAndroid = /android/i.test(ua);

      var statusText = document.getElementById('status-text');
      var fallbackContainer = document.getElementById('fallback-container');
      var fallbackLink = document.getElementById('fallback-link');

      var appOpened = false;
      function markOpened() { appOpened = true; }
      document.addEventListener('visibilitychange', function () {
        if (document.hidden || document.webkitHidden) markOpened();
      });
      window.addEventListener('pagehide', markOpened);
      window.addEventListener('blur', markOpened);

      setTimeout(function () {
        if (!appOpened && fallbackContainer) {
          fallbackContainer.style.opacity = '1';
        }
      }, 2500);

      if (isAndroid) {
        if (statusText) statusText.textContent = 'Redirecting...';
        if (fallbackLink) fallbackLink.href = playStore;

        var fallbackUrl = encodeURIComponent(playStore);
        var androidIntent = "intent://" + path + "#Intent;scheme=com.valens;package=" + packageId + ";S.browser_fallback_url=" + fallbackUrl + ";end";

        var startTime = Date.now();
        window.location.href = androidIntent;

        setTimeout(function () {
          var elapsed = Date.now() - startTime;
          if (!appOpened && elapsed < 2500) {
            window.location.href = playStore;
          }
        }, 1200);

      } else if (isIOS) {
        if (statusText) statusText.textContent = 'Redirecting...';
        if (fallbackLink) fallbackLink.href = appStore;

        var startTime = Date.now();
        window.location.href = "com.valens.app://" + path;

        setTimeout(function () {
          var elapsed = Date.now() - startTime;
          if (!appOpened && elapsed < 2500) {
            window.location.href = appStore;
          }
        }, 1200);

      } else {
        if (statusText) statusText.textContent = 'Redirecting to Valens...';
        if (fallbackLink) fallbackLink.href = webUrl;
        window.location.replace(webUrl);
      }
    })();
  </script>
</body>
</html>`);
  }
}
