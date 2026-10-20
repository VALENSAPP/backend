# Valens Backend (NestJS)

A high-performance, modular backend powering the **Valens** ecosystem, built with **[NestJS](https://nestjs.com/)**, **Prisma ORM**, and **PostgreSQL**.

---

## 📑 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Tech Stack](#-tech-stack)
- [Project Architecture](#-project-architecture)
- [Prerequisites](#-prerequisites)
- [Local Setup & Installation](#-local-setup--installation)
- [Environment Configuration](#-environment-configuration)
- [Database Migrations & Seeding](#-database-migrations--seeding)
- [Running the Application](#-running-the-application)
- [API Documentation (Swagger)](#-api-documentation-swagger)
- [Webhooks & Integrations](#-webhooks--integrations)
- [Real-Time WebSocket Events](#-real-time-websocket-events)
- [Available Scripts](#-available-scripts)
- [Production Deployment](#-production-deployment)
- [License](#-license)

---

## 🌟 Overview

Valens Backend provides the complete API and real-time infrastructure for a next-generation social, marketplace, and creator ecosystem. It supports multimedia feeds, direct/closet real-time messaging, multi-provider payment processing (Stripe & PagBank PIX/Connect), Web3 token management, automated KYC compliance, and shipping logistics.

---

## ✨ Key Features

- **Multi-Method Authentication & Security**:
  - Email & Password with secure bcrypt hashing
  - Social OAuth 2.0 (Google, Twitter, Apple ID)
  - Web3 Crypto Wallet authentication
  - JWT Bearer Authentication with Passport guards & brute-force rate limiters
- **Social & Content Feed**:
  - Media post creation (Images, Video with FFmpeg processing & Sharp optimization)
  - Stories & Reels support
  - Likes, Comments, Mentions, Bookmarks, and Shares
  - Private Circle subscription content
- **Marketplace & Closet**:
  - Product listings, cart, order workflows
  - Closet Chat & negotiation channels
  - Automated shipping calculations & labels with **EasyPost**
  - Marketplace Battles (Boosts, Challenges, Voting & Leaderboards)
- **Multi-Provider Payments & Wallet**:
  - **Stripe**: Card checkouts, subscriptions, payouts, and webhooks
  - **PagBank**: Brazilian PIX checkouts, OAuth Connect onboarding, split payments, and mTLS payouts
  - **Web3**: USDT & token integration on Polygon & Binance Smart Chain (BSC)
- **Identity & Compliance**:
  - Automated KYC verification with **SumSub** & **Veriff**
- **Real-Time Communication**:
  - WebSocket engine powered by **Socket.IO** for direct messages, closet chat, and online/seen presence
- **Notifications & Communication**:
  - Push notifications via **Firebase Cloud Messaging (FCM)**
  - Transactional emails via **SendGrid**
- **Internationalization & Documentation**:
  - Multi-language error messages & response formatting via `nestjs-i18n`
  - Interactive OpenAPI/Swagger documentation protected with HTTP Basic Auth

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | [NestJS 11](https://nestjs.com/) (Node.js / Express) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) |
| **Database & ORM** | [PostgreSQL](https://www.postgresql.org/) & [Prisma ORM 6](https://www.prisma.io/) |
| **Real-Time** | [Socket.IO](https://socket.io/) |
| **Cloud Storage** | [AWS S3](https://aws.amazon.com/s3/) |
| **Media Processing** | [Sharp](https://sharp.pixelplumbing.com/) & [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) |
| **Payments** | [Stripe](https://stripe.com/) & [PagBank](https://pagseguro.uol.com.br/) |
| **Web3** | [Ethers.js](https://docs.ethers.org/) (BSC & Polygon) |
| **KYC / Identity** | [SumSub](https://sumsub.com/) / [Veriff](https://www.veriff.com/) |
| **Shipping** | [EasyPost](https://www.easypost.com/) |
| **Push & Email** | [Firebase Admin SDK](https://firebase.google.com/) & [SendGrid Mail](https://sendgrid.com/) |
| **API Docs** | [NestJS Swagger (OpenAPI)](https://swagger.io/) |

---

## 📁 Project Architecture

```text
coin_backend/
├── prisma/
│   ├── schema.prisma                 # Database models & Prisma schema
│   ├── migrations/                   # SQL migration history
│   ├── seed-marketplace-boost-packages.ts # Seeder for marketplace packages
│   └── seed-posts.ts                 # Seeder for demo post data
├── src/
│   ├── auth/                         # JWT, OAuth (Google/Twitter/Apple), Wallet auth
│   ├── battle/                       # Marketplace battle mechanics & logic
│   ├── billing/                      # Billing & general payment handlers
│   ├── cart/                         # Cart management
│   ├── common/                       # Shared DTOs, guards, filters, interceptors, S3 utilities
│   ├── company-profile/              # Business/Company profile management
│   ├── deep-link/                    # App deep linking handlers
│   ├── i18n/                         # Internationalization translations (JSON)
│   ├── kyc/                          # KYC verification logic
│   ├── marketPlace/                  # Marketplace, products, closet chat & shipping
│   ├── moderation/                   # Content moderation
│   ├── notification/                 # Push notifications (FCM) & email dispatch
│   ├── pagbank/                      # PagBank client, OAuth connect, PIX checkout & webhooks
│   ├── post/                         # Posts, feeds, comments, likes, and media
│   ├── post-message/                 # Post-related messaging
│   ├── prisma/                       # Prisma client service & lifecycle management
│   ├── private-circle/               # Private circle subscriber content
│   ├── rewards/                      # Gamification & rewards system
│   ├── story/                        # Stories & ephemeral content
│   ├── stripe1/                      # Stripe payment integration
│   ├── sumsub-verification/          # SumSub KYC provider integration
│   ├── swagger/                      # Swagger OpenAPI configuration
│   ├── token/                        # Web3 token & smart contract interactions
│   ├── token-purchase/               # Token purchase workflows
│   ├── user/                         # User profile, settings, follow graph, wallet
│   ├── wallet/                       # Multi-provider balance & payout routing
│   ├── app.module.ts                 # Root application module
│   └── main.ts                       # Application entrypoint & HTTP/Socket server
├── .env.example                      # Environment variables reference template
├── ecosystem.config.js               # PM2 production configuration
├── package.json                      # Dependencies & scripts
└── tsconfig.json                     # TypeScript configuration
```

---

## 📦 Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v18.x` or `v20.x` or higher
- **PostgreSQL**: `v14+` running locally or accessible remotely
- **npm**: `v9+` or `yarn`

---

## 🚀 Local Setup & Installation

### 1. Navigate to the Backend Directory
```bash
cd coin_backend
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy the example environment file and fill in your credentials:
```bash
cp .env.example .env
```
*(See [Environment Configuration](#-environment-configuration) for critical variables).*

### 4. Run Migrations & Generate Prisma Client
```bash
npx prisma migrate dev
npx prisma generate
```

### 5. Seed Initial Data *(Optional)*
```bash
# Seed marketplace boost packages
npm run seed:boost-packages

# Seed initial demo posts (optional)
npm run seed:posts
```

### 6. Start the Development Server
```bash
npm run start:dev
```
The server will start on `http://localhost:3002` (or the `PORT` specified in `.env`).

---

## 🔐 Environment Configuration

A complete `.env.example` template is provided in the repository. Key configuration groups include:

### Database & Core
```env
PORT=3002
HOST=0.0.0.0
DATABASE_URL="postgresql://postgres:password@localhost:5432/valens_db"
JWT_SECRET="your_jwt_secret_key"
BASE_URL="http://localhost:3002"
BACKEND_URL="http://localhost:3002"
```

### AWS S3 (Media Storage)
```env
AWS_ACCESS_KEY_ID="your_aws_key"
AWS_SECRET_ACCESS_KEY="your_aws_secret"
AWS_REGION="us-west-1"
AWS_S3_BUCKET="your_bucket_name"
```

### PagBank Integration
```env
PAGBANK_ENV=sandbox                           # 'sandbox' or 'production'
PAGBANK_TOKEN="your_pagbank_token"            # Platform application token
PAGBANK_CLIENT_ID="your_pagbank_client_id"    # OAuth Connect Client ID
PAGBANK_CLIENT_SECRET="your_client_secret"    # OAuth Client Secret
PAGBANK_WEBHOOK_SECRET="your_webhook_secret"  # Webhook signature validation token
PAGBANK_CONNECT_REDIRECT_URI="http://localhost:3002/billing/pagbank/callback"
PAGBANK_NOTIFICATION_URL="http://localhost:3002/billing/pagbank/webhook"
PAGBANK_PLATFORM_ACCOUNT_ID="your_platform_account_id"
PAGBANK_DEFAULT_TAX_ID="12345678909"          # Default fallback CPF/CNPJ for checkout tests
```

### Stripe Integration
```env
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_SUCCESS_URL="http://localhost:3002/api"
STRIPE_CANCEL_URL="http://localhost:3002"
```

### Firebase (Push Notifications) & SendGrid (Email)
```env
FIREBASE_PROJECT_ID="your_project_id"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk@...iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SENDGRID_API_KEY="SG...."
SENDGRID_FROM_EMAIL="no-reply@valens.app"
```

### Swagger Protection
```env
SWAGGER_USERNAME="admin"
SWAGGER_PASSWORD="your_secure_password"
```

---

## 📖 API Documentation (Swagger)

### PIX tip checkout

`POST /billing/send-tip` selects the provider from the authenticated buyer. For a PagBank buyer, the response includes `provider`, `paymentId`, `orderId`, `currency`, `amountMinor`, `qrCode`, `pixCopyPaste` and `expiresAt`. The existing `url` field is retained for older clients; Stripe responses remain URL-based.

The native client uses `GET /billing/transaction-details?paymentId=...` to check the payment. The Payment response includes the existing localized `status` plus `rawStatus` for machine-readable confirmation. Access remains restricted to the payment sender or receiver. Creating a checkout is not proof of payment; confirmation follows the backend payment status updated by the provider webhook.

Configure the platform PagBank Sandbox credentials only on the backend. Do not include platform tokens in the mobile application.


The API is fully documented using OpenAPI/Swagger.

- **Swagger UI Path:** `http://localhost:3002/api` (or `https://api.valens.app/api` on production/staging)
- **OpenAPI JSON Spec:** `http://localhost:3002/api-json`
- **Authentication:** Protected by HTTP Basic Auth. Enter the values configured for `SWAGGER_USERNAME` and `SWAGGER_PASSWORD` in your `.env`.

> **Tip (Postman Import):** Open Postman, click **Import**, and paste the URL `http://localhost:3002/api-json` to instantly generate the full Postman collection.

---

## 🔗 Webhooks & Integrations

The application includes dedicated raw-body webhook listeners for secure third-party signature validation:

| Provider | Endpoint | Testing & Forwarding Command |
|---|---|---|
| **Stripe** | `/billing/webhook` | `stripe listen --forward-to localhost:3002/billing/webhook` |
| **PagBank** | `/billing/pagbank/webhook` | Receives PIX/Order & Transfer webhooks |
| **SumSub KYC** | `/sumsub-verification/webhook` | Handles applicant verification status updates |
| **EasyPost** | `/shipping/easypost/webhook` | Handles tracking & delivery updates |

---

## ⚡ Real-Time WebSocket Events

Socket.IO runs on the same port as the HTTP server. Clients authenticate/connect with `?userId=<USER_ID>`.

### Key Socket Events:

| Direction | Event Name | Payload / Description |
|---|---|---|
| `client -> server` | `getUserChatBox` | `{ userId: string }` - Fetch active chat conversations |
| `client -> server` | `getConversation` | `{ userId: string, otherUserId: string }` - Fetch chat message thread |
| `client -> server` | `markMessageSeen` | `{ messageId: string, userId: string, otherUserId?: string }` |
| `client -> server` | `getClosetChatThreads` | `{ userId: string }` - Fetch closet negotiations |
| `client -> server` | `sendClosetChatMessage` | `{ userId: string, threadId: string, message: string }` |
| `server -> client` | `userChatBox` | Returns updated user chat boxes |
| `server -> client` | `closetChatNewMessage` | Pushes incoming closet message to receiver in real time |
| `server -> client` | `messageSeen` | Broadcasts read-receipt status update |

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run start:dev` | Starts the app in development mode with hot-reload (`--watch`) |
| `npm run build` | Compiles the TypeScript code into the `dist/` directory |
| `npm run start:prod` | Runs the compiled production build from `dist/` |
| `npm run start:debug` | Starts the app in debug mode |
| `npm run format` | Formats all source code using Prettier |
| `npm run lint` | Runs ESLint and auto-fixes issues |
| `npm run seed:boost-packages` | Seeds database with marketplace battle boost packages |
| `npm run seed:posts` | Seeds database with initial demo posts |
| `npm run backfill:conversation-ownerid` | Runs conversation owner ID database migration script |

---

## 🚢 Production Deployment

### 1. Build the Application
```bash
npm run build
```

### 2. Run Database Migrations on Production
```bash
npx prisma migrate deploy
```

### 3. Process Management with PM2
An `ecosystem.config.js` is included for zero-downtime clustering and auto-restarts:
```bash
# Start with PM2
pm2 start ecosystem.config.js

# View PM2 logs
pm2 logs backend-server

# Restart application
pm2 restart backend-server
```

---

## 📄 License

This project is proprietary and confidential. Unauthorized copying, distribution, or modification is strictly prohibited.

## Swagger

Swagger Url - https://api.valens.app/api
Swagger Username - valens
Swagger Password - Valens@7878