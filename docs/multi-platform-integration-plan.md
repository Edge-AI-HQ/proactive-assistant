# Multi-Platform Gateway Integration Plan

## Cloud-Hosted Personal AI Assistant via Web Portal

**Date:** 2026-03-16 (updated 2026-03-17)  
**Status:** Draft / RFC  
**Author:** PIN AI Engineering

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Baseline](#2-current-architecture-baseline) (includes Infrastructure Reuse Analysis)
3. [Target Architecture](#3-target-architecture)
4. [Per-Platform Detailed Architecture](#4-per-platform-detailed-architecture)
5. [Web Portal Design](#5-web-portal-design)
6. [Backend Architecture Changes](#6-backend-architecture-changes)
7. [Database Schema Evolution](#7-database-schema-evolution)
8. [Container Configuration Changes](#8-container-configuration-changes)
9. [Security Considerations](#9-security-considerations)
10. [Implementation Phases](#10-implementation-phases)
11. [Risk Matrix](#11-risk-matrix)
12. [Decisions Log](#12-decisions-log-resolved)
13. [Resolved Follow-Up Items](#13-resolved-follow-up-items)

---

## 1. Executive Summary

### Goal

Build a **web portal** where users can create and manage a personal AI assistant connecting to **4 messaging platforms**: Telegram, WhatsApp, Discord, and Slack. Users log in via **Google OAuth2 (Gmail)**.

### Core Decision: All Platforms Use BYOB (Bring Your Own Bot)

Every platform uses the **BYOB model** — the user provides their own credentials, we help them set up and run the bot:

| Platform | What User Provides | Setup UX on Web Portal |
|----------|-------------------|----------------------|
| **Telegram** | Bot Token (from @BotFather) | Paste token into form (+ Quick Start shared bot option) |
| **WhatsApp** | Phone scan | Scan QR code displayed on portal |
| **Discord** | Bot Token (from Developer Portal) | Paste token into form |
| **Slack** | Bot Token + App Token (from Slack App config) | Paste tokens into form |

**Why all BYOB:**
- Each user's bot is fully isolated — no cross-user impact.
- User controls their bot's name, avatar, and identity.
- No APIs-level message routing needed — each container connects directly to the platform.
- Simpler engineering: no webhook fan-out, no platform-level OAuth, no shared token protection.
- Telegram keeps its existing Quick Start mode (shared bot) as a convenience option for users who don't want to create their own bot.

### Key Architectural Consequence

Since all platforms use user-owned tokens and direct connections, the **APIs service does NOT need to proxy or route messages** for WhatsApp, Discord, or Slack. The only platform that still requires an APIs proxy is Telegram Quick Start (shared bot). For all other cases, the OpenClaw container connects directly to the platform's servers.

```
BYOB Architecture (WhatsApp / Discord / Slack / Telegram BYOB):

  Platform Servers  <──direct connection──>  User's OpenClaw Container (Fly.io)
                                              (holds user's own token)

Telegram Quick Start (existing, shared bot):

  Telegram API  <──proxy──>  APIs  <──forward──>  User's OpenClaw Container
                             (holds shared bot token)
```

> **Note:** iMessage is excluded from scope. It requires macOS; Fly.io runs Linux. May revisit in the future via BlueBubbles bridge.

---

## 2. Current Architecture Baseline

### System Topology (as of 2026-03-16)

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│ Telegram API │────>│ pinclaw-api-dev  │────>│ pinclaw-assistant-  │
│              │<────│   (APIs app)     │<────│  dev (per-user      │
│              │     │                  │     │  OpenClaw machines)  │
└─────────────┘     └──────────────────┘     └────────────────────┘
                           │
                    ┌──────┴──────┐
                    │  Supabase   │
                    │  (Postgres) │
                    └─────────────┘
```

### Current Limitations

1. **Telegram-only identity**: `users.telegram_user_id` is the sole user identifier (UNIQUE NOT NULL).
2. **No platform abstraction**: Message routing is hardcoded for Telegram update format.
3. **No web-based management UI**: The existing Mini App is Telegram-embedded, not a standalone portal.
4. **Container config is Telegram-specific**: `buildAssistantOpenclawConfig()` only generates `channels.telegram`.
5. **No channel status tracking**: No DB model for "which platforms is this assistant connected to."

### Existing Infrastructure Reuse Analysis

The current Quick Start architecture has significant infrastructure that is **platform-agnostic** and directly reusable for WhatsApp, Discord, and Slack. Only a thin "Telegram coupling layer" needs modification.

#### Fully Reusable (No Changes Needed)

| Component | What It Does | Why It's Platform-Agnostic |
|-----------|-------------|---------------------------|
| **Container Orchestrator** (`orchestrator.ts`) | Creates/destroys/restarts Fly machines, dedup in-flight requests | Takes a config blob, creates a machine. Doesn't care what channels are inside. |
| **Fly Machine Provider** (`assistant_machine.ts`) | Fly Machines API calls, volume management, region fallback | Pure infrastructure — creates VMs with any config. |
| **Drift Detection** | Compares config hash → auto-recreates if changed | Hashes the full config JSON. Adding Discord/Slack/WA config changes the hash → triggers rebuild automatically. |
| **Health Probing** | WS hello to gateway port → TCP/HTTP probe | Probes the OpenClaw gateway process, not a specific channel. Works regardless of which channels are enabled. |
| **LiteLLM Per-User Key** (`assistant_litellm_key.ts`) | Creates a LiteLLM virtual key per assistant | AI model routing is independent of which messaging platform the user talks from. |
| **LiteLLM Budget Sync** (`litellmBudget.ts`) | Maps plan credits → USD → LiteLLM max_budget | Budget management is per-user, not per-platform. |
| **Stripe Payment** (`checkout.ts`, `subscriptionSync.ts`) | Checkout, invoice handling, subscription lifecycle | Core billing logic is platform-agnostic. Just need to decouple from `telegram_user_id`. |
| **OpenClaw Config Base** (`openclaw_config.ts`) | `gateway`, `models`, `tools`, `commands`, `browser`, `cron`, `skills` sections | Everything except `channels` and `plugins.entries` is reusable as-is. |
| **Container Env Vars** (`webhook_params.ts`) | `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `NODE_COMPILE_CACHE`, etc. | Most env vars are platform-agnostic. Only Telegram-specific ones need conditional logic. |

#### Needs Modification (Telegram Coupling Points)

| Coupling Point | Current Code | What Changes |
|---------------|-------------|-------------|
| **User identity** | `users.telegram_user_id` (UNIQUE NOT NULL), used everywhere as primary lookup | Add `google_id` column. Use `user.id` (UUID) as internal primary key. `telegram_user_id` becomes nullable. |
| **Config `channels` section** | Hardcoded `channels.telegram = { botToken, webhookUrl, ... }` | Build dynamically from `channel_connections` table: loop over active connections, generate per-platform config section. |
| **Webhook routes** | `POST /webhook/telegram` only | Keep for Telegram (both QS and BYOB). WhatsApp/Discord/Slack use direct connections — no inbound webhook on APIs needed. |
| **Outbound proxy** | `telegram-api-proxy` plugin + `POST /api/telegram/:method` | Keep for Telegram Quick Start only. BYOB platforms send directly — no proxy needed. |
| **Plugin list** | Always includes `telegram`, `telegram-api-proxy`, `litellm-vision-adapter`, `platform-hooks` | Conditionally include per-platform plugins. `telegram-api-proxy` only for QS mode. |
| **Guide Bot** | Grammy bot handles `/start`, `/subscribe`, onboarding | Web portal replaces Guide Bot for non-Telegram users. Guide Bot remains for Telegram Quick Start backward compat. |
| **State lookup** | `findUserState(chatId)` queries by `telegram_user_id` | Portal calls `GET /channels/status` using session auth. No need for `findUserState` equivalent — portal knows the user's container directly. |
| **Ready notification** | `ContainerNotifier.notifyReady()` sends Telegram message | For portal users: notify via WebSocket. For Telegram QS users: keep existing Telegram notification. |
| **Payment metadata** | Stripe `metadata.telegram_user_id` | Change to `metadata.user_id` (UUID). Portal initiates payment, not Telegram bot. |
| **Subscription guard** | `hasActiveSubscriptionForService(String(chatId))` | Change to `hasActiveSubscriptionForUser(userId: UUID)`. |
| **Container env (TG-specific)** | `TELEGRAM_ROUTER_URL`, `OPENCLAW_TELEGRAM_WEBHOOK_PORT` | Include only when Telegram is enabled. Other platforms don't need these. |

#### Reuse Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                    Current Architecture                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Platform-Agnostic (REUSE AS-IS) — ~80%                    │ │
│  │                                                             │ │
│  │  Container Orchestrator · Fly Machine Provider              │ │
│  │  Drift Detection · Health Probing                           │ │
│  │  LiteLLM Keys · LiteLLM Budget · Stripe Billing            │ │
│  │  OpenClaw Config (gateway/models/tools/skills/browser/cron) │ │
│  │  Container Env (LITELLM_*, NODE_COMPILE_CACHE, etc.)        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Telegram Coupling Layer (MODIFY) — ~20%                    │ │
│  │                                                             │ │
│  │  User Identity (telegram_user_id → google_id + user.id)     │ │
│  │  Config channels section (hardcoded TG → dynamic per-plat)  │ │
│  │  Webhook routes · Outbound proxy · Plugin list              │ │
│  │  Guide Bot → Web Portal · Notification → WebSocket          │ │
│  │  Payment metadata · Subscription guard                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Target Architecture

### High-Level Design

```
                     ┌──────────────────────────────────────────────┐
                     │              Web Portal (React SPA)          │
                     │                                              │
                     │  Google Login -> Dashboard -> Platform Setup  │
                     │                                              │
                     │  ┌─────┐ ┌─────┐ ┌───────┐ ┌─────┐         │
                     │  │ TG  │ │ WA  │ │Discord│ │Slack│         │
                     │  │token│ │ QR  │ │ token │ │token│         │
                     │  └──┬──┘ └──┬──┘ └───┬───┘ └──┬──┘         │
                     └─────┼───────┼────────┼────────┼─────────────┘
                           │       │        │        │
                           ▼       ▼        ▼        ▼
                     ┌─────────────────────────────────────────────┐
                     │           pinclaw-api (APIs)                │
                     │                                             │
                     │  ┌────────────────────────────────────────┐ │
                     │  │   Channel Connection Manager           │ │
                     │  │   - Validate tokens                    │ │
                     │  │   - Store credentials (encrypted)      │ │
                     │  │   - Relay WhatsApp QR (WebSocket)      │ │
                     │  │   - Trigger container rebuild/reload   │ │
                     │  └────────────────────────────────────────┘ │
                     │                                             │
                     │  ┌────────────────────────────────────────┐ │
                     │  │   Container Orchestrator               │ │
                     │  │   - Build multi-channel OpenClaw config │ │
                     │  │   - Create/rebuild Fly machines        │ │
                     │  │   - Health monitoring                  │ │
                     │  └────────────────────────────────────────┘ │
                     │                                             │
                     │  ┌────────────────────────────────────────┐ │
                     │  │   Telegram Router (existing, for QS)   │ │
                     │  │   - Quick Start shared bot proxy only  │ │
                     │  └────────────────────────────────────────┘ │
                     └──────────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────┬┴──────────────────┐
                    ▼                   ▼                    ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │ User A       │   │ User B       │   │ User C       │
            │ OpenClaw     │   │ OpenClaw     │   │ OpenClaw     │
            │ Container    │   │ Container    │   │ Container    │
            │              │   │              │   │              │
            │ ┌──────────┐ │   │ ┌──────────┐ │   │ ┌──────────┐ │
            │ │TG (BYOB) │ │   │ │TG (QS)  │ │   │ │WA        │ │
            │ │WA        │ │   │ │Discord   │ │   │ │Slack     │ │
            │ │Discord   │ │   │ └──────────┘ │   │ └──────────┘ │
            │ └──────────┘ │   │              │   │              │
            │   ▲  ▲  ▲    │   │   ▲  ▲      │   │   ▲  ▲      │
            └───┼──┼──┼────┘   └───┼──┼──────┘   └───┼──┼──────┘
                │  │  │            │  │               │  │
                ▼  ▼  ▼            ▼  ▼               ▼  ▼
             TG WA Discord      TG Discord          WA Slack
             API API  API       API  API            API  API
           (direct connections — each container uses user's own tokens)
```

### Core Principles

1. **All BYOB**: User provides their own platform credentials. Container connects directly to platform servers.
2. **Each user gets one OpenClaw container** running all their enabled channels.
3. **APIs is the control plane only**: manages container lifecycle, stores credentials, relays WhatsApp QR. Does NOT route regular messages (except Telegram Quick Start).
4. **Identity via Google OAuth2**: users log in with Google (Gmail) account.
5. **Channel state tracked in DB**: which platforms are connected, status, encrypted credentials.

---

## 4. Per-Platform Detailed Architecture

### 4.1 Telegram

#### 4.1.1 Two Modes

**Mode A: Quick Start (existing, shared bot)**

This is the current production flow. User does NOT need to create a bot. They use our shared platform bot.

```
Telegram User  ──msg──>  Telegram API
                              │
                              ▼
                    APIs (/webhook/telegram)
                         │
                         ├── Identify user by chat_id
                         ├── Find user's container
                         │
                         ▼
                    Container (:8787 webhook)
                         │
                         ├── OpenClaw processes message with AI
                         │
                         ▼
                    Container calls APIs (/api/telegram/sendMessage)
                         │
                         ├── APIs injects real shared bot token
                         │
                         ▼
                    Telegram API (sends reply)
```

- Container holds synthetic token `0:...`, never the real shared bot token.
- All Telegram API calls proxied through APIs (P0 security).
- Already implemented and working.

**Mode B: BYOB (new)**

User creates their own bot via @BotFather and provides the token.

```
Telegram User  ──msg──>  Telegram API
                              │
                              ▼
                    Container (:8787 webhook, registered directly with Telegram)
                         │
                         ├── OpenClaw processes message with AI
                         │
                         ▼
                    Container calls Telegram API directly
                    (using user's own bot token)
```

- Container holds user's own bot token in OpenClaw config.
- Container registers its own webhook URL with Telegram (via `setWebhook`).
- No APIs proxy needed — direct connection.
- **Webhook URL challenge**: Fly machines don't have stable public URLs. Solutions:
  - Option 1: Use Fly.io's built-in proxy (`<machine-id>.fly.dev`) if available.
  - Option 2: Route through APIs anyway: `APIs /webhook/telegram/:userId -> Container`. This reuses the existing infrastructure but the container uses its own token for outbound.
  - **Recommended**: Option 2 (reuse APIs as inbound webhook receiver, but container sends outbound directly with its own token). This avoids the need for per-machine public URLs.

#### 4.1.2 Implementation Steps

1. **Web portal: Telegram setup page**
   - Two options presented: "Quick Start" (one-click) and "Use your own bot" (paste token).
   - For BYOB: text field for bot token, "Connect" button.
   - Portal calls `POST /channels/telegram/connect` with `{ mode: "byob", botToken: "..." }` or `{ mode: "quickstart" }`.

2. **APIs: token validation**
   - For BYOB: call `https://api.telegram.org/bot<token>/getMe` to verify the token is valid.
   - Extract bot username, store in `channel_connections`.

3. **APIs: webhook registration (for BYOB)**
   - Call `setWebhook` on the user's bot, pointing to `https://<apis-domain>/webhook/telegram/<userId>`.
   - APIs routes incoming webhooks to the correct container (same mechanism as Quick Start, but using user's own bot for outbound).

4. **Container config generation**
   - BYOB: `channels.telegram.botToken = "<user's token>"`, no `telegram-api-proxy` plugin.
   - Quick Start: `channels.telegram.botToken = "0:synthetic"`, with `telegram-api-proxy` plugin (existing).

5. **Container rebuild**: On connect/disconnect, rebuild container with updated config.

#### 4.1.3 Telegram BYOB Inbound Webhook Flow (Detailed)

```
Telegram API
    │
    ▼
APIs: POST /webhook/telegram/:userId
    │
    ├── Look up user's container (runtime_instances table)
    ├── Forward entire Telegram Update JSON to container
    │
    ▼
Container: POST http://[container-ip]:8787/telegram-webhook
    │
    ├── OpenClaw Telegram channel plugin processes the update
    ├── AI generates response
    │
    ▼
Container: POST https://api.telegram.org/bot<USER_TOKEN>/sendMessage
    (direct call, no proxy)
```

**Estimated Effort:** ~1-2 weeks (BYOB mode on top of existing Quick Start)

---

### 4.2 WhatsApp (via Baileys)

#### 4.2.1 Architecture

WhatsApp uses the Baileys library to simulate WhatsApp Web. This is inherently BYOB — the user "logs in" by scanning a QR code with their phone, linking their personal WhatsApp account.

**No APIs routing is needed.** The Baileys client inside the container maintains a persistent encrypted WebSocket to WhatsApp servers. Messages flow directly between the container and WhatsApp.

```
WhatsApp Servers
    ▲           │
    │ outbound  │ inbound
    │           ▼
Container (Baileys WebSocket — persistent connection)
    │
    ├── Baileys receives message via `messages.upsert` event
    ├── OpenClaw processes with AI
    ├── Baileys sends reply via `sock.sendMessage()`
    │
    (all direct, no APIs involvement for regular messages)
```

**The only APIs involvement is during the initial QR pairing flow:**

```
Web Portal                    APIs                      Container
    │                          │                           │
    ├── "Connect WhatsApp" ──> │                           │
    │                          ├── Ensure container is ──> │
    │                          │   running                 │
    │                          │                           │
    │   <── WebSocket ────────>│<── Gateway RPC ──────────>│
    │       connection         │    connection             │
    │                          │                           │
    │                          ├── Call loginWithQrStart() │
    │                          │                           ├── Baileys generates QR
    │                          │<── QR code (base64 PNG) ──┤
    │<── QR image via WS ─────┤                           │
    │                          │                           │
    │   [User scans QR with phone]                        │
    │                          │                           │
    │                          │<── "connected" status ────┤
    │<── success via WS ──────┤                           │
    │                          │                           │
    │   DONE. Container now has persistent WA connection.  │
```

#### 4.2.2 Session Persistence

Baileys stores authentication state (session keys, credentials) as files on disk:
- **Path**: `/data/web/auth/` on the container's Fly persistent volume.
- On container restart, Baileys reads the auth state and reconnects automatically — **no re-scan needed**.
- If the user unlinks the device from their phone (Settings > Linked Devices), the session becomes invalid and re-pairing is required.

#### 4.2.3 Implementation Steps

1. **OpenClaw image rebuild**: Ensure the Docker image includes `@whiskeysockets/baileys` and the WhatsApp channel plugin.

2. **APIs: WhatsApp pairing endpoint**
   - `POST /channels/whatsapp/pair` — returns a WebSocket ticket.
   - Portal opens WebSocket to `WS /channels/ws?ticket=<ticket>`.
   - APIs connects to the container's gateway RPC (via internal Fly network).
   - APIs calls `loginWithQrStart()` on the container.
   - QR code data is relayed from container → APIs → portal in real-time.
   - QR codes expire every ~20 seconds; Baileys regenerates them automatically. APIs relays each new QR.

3. **Web portal: WhatsApp page**
   - Shows a large QR code area.
   - Instructions: "Open WhatsApp on your phone > Settings > Linked Devices > Link a Device > Scan this QR code".
   - Status indicator: "Waiting for scan..." → "Connected!" → "Phone: +1234...".
   - Disconnect button.

4. **Container config generation**
   - When WhatsApp is connected:
     ```jsonc
     "channels": {
       "whatsapp": {
         "authDir": "/data/web/auth",
         "dmPolicy": "open",
         "textChunkLimit": 4000
       }
     }
     ```
   - Note: No token/credentials needed in config — Baileys uses the auth state files on disk.

5. **Health monitoring**
   - APIs periodically probes the container's gateway API to check WhatsApp connection status.
   - Possible states: `connected`, `disconnected` (session expired), `connecting` (reconnecting).
   - Portal shows status in real-time via WebSocket.

6. **Disconnect flow**
   - User clicks "Disconnect" on portal.
   - APIs calls `logoutAccount()` on the container.
   - Baileys calls `sock.logout()`, clears auth state files.
   - `channel_connections` row updated to `status = 'disconnected'`.

**Estimated Effort:** ~3-4 weeks

---

### 4.3 Discord

#### 4.3.1 Architecture

Discord uses the Bot API. The user creates a bot on Discord Developer Portal and provides the token. The container connects to Discord's Gateway WebSocket directly.

**No APIs routing needed.** The bot runs entirely inside the container.

```
Discord Servers (Gateway WebSocket)
    ▲              │
    │ outbound     │ inbound events (messageCreate, etc.)
    │ (REST API)   ▼
Container (Discord bot client — persistent WebSocket)
    │
    ├── Receives messageCreate events
    ├── OpenClaw processes with AI
    ├── Sends reply via Discord REST API (POST /channels/:id/messages)
    │
    (all direct, no APIs involvement)
```

#### 4.3.2 User Setup Flow (Guided on Web Portal)

The portal provides a **step-by-step interactive guide**:

```
Step 1: Create a Discord Application
  ┌──────────────────────────────────────────────────┐
  │  Go to discord.com/developers/applications       │
  │  Click "New Application" → name it anything      │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 2: Create a Bot
  ┌──────────────────────────────────────────────────┐
  │  In your app, go to "Bot" tab                    │
  │  Click "Add Bot" → "Yes, do it!"                 │
  │  Under "Privileged Gateway Intents":              │
  │    ☑ Message Content Intent                       │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 3: Copy Bot Token
  ┌──────────────────────────────────────────────────┐
  │  Click "Reset Token" → Copy the token            │
  │                                                  │
  │  Bot Token: [_______________________________]    │
  │                                                  │
  │                                       [Connect]  │
  └──────────────────────────────────────────────────┘

Step 4: Invite Bot to Your Server
  ┌──────────────────────────────────────────────────┐
  │  We generated an invite link for your bot:       │
  │  [Click here to add bot to your Discord server]  │
  │                                                  │
  │  Select a server → Authorize                     │
  │                                          [Done]  │
  └──────────────────────────────────────────────────┘
```

#### 4.3.3 Implementation Steps

1. **Web portal: Discord setup page** — Interactive step-by-step guide as shown above. Final step: paste token.

2. **APIs: token validation**
   - `POST /channels/discord/connect` with `{ botToken: "..." }`.
   - APIs validates by calling `GET https://discord.com/api/v10/users/@me` with the token.
   - Extracts bot username, avatar, bot ID.
   - Stores encrypted token in `channel_connections.credentials`.

3. **APIs: generate invite URL**
   - Uses the bot's `client_id` (from token validation) to generate:
     `https://discord.com/api/oauth2/authorize?client_id=<BOT_ID>&scope=bot&permissions=<PERMS>`
   - Required permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`.
   - Returns this URL to the portal for the user to click.

4. **Container config generation**
   ```jsonc
   "channels": {
     "discord": {
       "botToken": "<user's bot token>",
       "dm": { "policy": "open" },
       "streaming": { "mode": "edit" }
     }
   }
   ```

5. **Container rebuild**: On connect, rebuild container with Discord config included. The OpenClaw Discord plugin (`@buape/carbon`) will automatically connect to Discord Gateway using the token.

6. **Status monitoring**
   - APIs probes container gateway for Discord bot status.
   - Possible states: `online` (connected to Gateway), `offline` (disconnected), `error` (invalid token).
   - If the user resets their token on Discord Developer Portal, the bot goes offline. Portal shows re-connect prompt.

7. **Disconnect flow**
   - User clicks "Disconnect" on portal.
   - APIs removes Discord config from container, triggers rebuild.
   - `channel_connections` row updated.
   - Note: The bot still exists on Discord Developer Portal; we just stop running it. User can delete it themselves if they want.

**Estimated Effort:** ~2 weeks

---

### 4.4 Slack

#### 4.4.1 Architecture

Slack uses the Bolt SDK in **Socket Mode**. The user creates a Slack App, provides `botToken` + `appToken`. The container connects directly to Slack via WebSocket (Socket Mode).

**No APIs routing needed.** Socket Mode means Slack sends events directly to the container's WebSocket connection — no public webhook URL required.

```
Slack Servers (Socket Mode WebSocket)
    ▲              │
    │ outbound     │ inbound events (message, app_mention, etc.)
    │ (Web API)    ▼
Container (Bolt SDK — Socket Mode persistent WebSocket)
    │
    ├── Receives message events
    ├── OpenClaw processes with AI
    ├── Sends reply via Slack Web API (chat.postMessage)
    │
    (all direct, no APIs involvement)
```

**Why Socket Mode is ideal for BYOB:**
- No public webhook URL needed — Slack pushes events to the container via WebSocket.
- Works inside Fly.io's private network (no inbound routing needed).
- Simpler than HTTP mode (no webhook signature verification, no URL configuration).

#### 4.4.2 User Setup Flow (Guided on Web Portal)

```
Step 1: Create a Slack App
  ┌──────────────────────────────────────────────────┐
  │  Go to api.slack.com/apps                        │
  │  Click "Create New App" → "From scratch"          │
  │  Name: anything (e.g., "My AI Assistant")         │
  │  Workspace: select your workspace                 │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 2: Enable Socket Mode
  ┌──────────────────────────────────────────────────┐
  │  Go to "Socket Mode" in left sidebar              │
  │  Toggle "Enable Socket Mode" → ON                │
  │  It will ask you to create an App-Level Token:    │
  │    Name: "socket" → Scope: connections:write      │
  │  Copy the App Token (starts with xapp-...)        │
  │                                                   │
  │  App Token: [_______________________________]     │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 3: Configure Bot Permissions
  ┌──────────────────────────────────────────────────┐
  │  Go to "OAuth & Permissions" in left sidebar      │
  │  Under "Bot Token Scopes", add:                   │
  │    ☑ chat:write                                   │
  │    ☑ channels:history                             │
  │    ☑ groups:history                               │
  │    ☑ im:history                                   │
  │    ☑ mpim:history                                 │
  │    ☑ app_mentions:read                            │
  │    ☑ files:write                                  │
  │    ☑ reactions:write                              │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 4: Enable Event Subscriptions
  ┌──────────────────────────────────────────────────┐
  │  Go to "Event Subscriptions" in left sidebar      │
  │  Toggle "Enable Events" → ON                      │
  │  Under "Subscribe to bot events", add:            │
  │    ☑ message.channels                             │
  │    ☑ message.groups                               │
  │    ☑ message.im                                   │
  │    ☑ message.mpim                                 │
  │    ☑ app_mention                                  │
  │  Click "Save Changes"                             │
  │                                          [Next >] │
  └──────────────────────────────────────────────────┘

Step 5: Install to Workspace & Get Bot Token
  ┌──────────────────────────────────────────────────┐
  │  Go to "OAuth & Permissions"                      │
  │  Click "Install to Workspace" → "Allow"           │
  │  Copy the "Bot User OAuth Token" (starts with     │
  │  xoxb-...)                                        │
  │                                                   │
  │  Bot Token: [_______________________________]     │
  │                                                   │
  │                                       [Connect]   │
  └──────────────────────────────────────────────────┘
```

#### 4.4.3 Implementation Steps

1. **Web portal: Slack setup page** — Interactive step-by-step guide. Two token fields: App Token (`xapp-...`) and Bot Token (`xoxb-...`).

2. **APIs: token validation**
   - `POST /channels/slack/connect` with `{ botToken: "xoxb-...", appToken: "xapp-..." }`.
   - APIs validates bot token by calling `https://slack.com/api/auth.test` with `Authorization: Bearer <botToken>`.
   - Extracts team name, bot user ID, team ID.
   - Validates app token format (starts with `xapp-`).
   - Stores both encrypted tokens in `channel_connections.credentials`.

3. **Container config generation**
   ```jsonc
   "channels": {
     "slack": {
       "botToken": "<user's xoxb- token>",
       "appToken": "<user's xapp- token>",
       "mode": "socket",
       "dm": { "policy": "open" },
       "streaming": { "mode": "edit" }
     }
   }
   ```

4. **Container rebuild**: On connect, rebuild container with Slack config. The OpenClaw Slack plugin (Bolt SDK, Socket Mode) will automatically connect to Slack's WebSocket using the tokens.

5. **Status monitoring**
   - APIs probes container gateway for Slack connection status.
   - Possible states: `connected`, `disconnected`, `error` (invalid/revoked token).
   - If the user uninstalls the app from their workspace or revokes the token, the bot disconnects. Portal shows re-connect prompt.

6. **Disconnect flow**
   - User clicks "Disconnect" on portal.
   - APIs removes Slack config, triggers container rebuild.
   - `channel_connections` row updated.

**Estimated Effort:** ~2-3 weeks

---

### 4.5 iMessage — Out of Scope

iMessage requires macOS. Fly.io runs Linux. No cloud-native path exists. If revisited, the only option is the BlueBubbles bridge (user runs a Mac at home). See OpenClaw's `extensions/bluebubbles/` for reference.

---

## 5. Web Portal Design

### 5.1 Standalone Web App

The portal is a **standalone React SPA** (not embedded in Telegram), accessible from any browser.

- **Tech stack**: React + Vite + Tailwind CSS (consistent with existing miniapp).
- **Hosting**: **Fly.io** (same platform as APIs; simplifies deployment and internal networking).
- **Domain**: Main domain (e.g., `pinclaw.com`). Google OAuth redirect URI and CORS configured for this domain.
- **API communication**: REST calls to APIs service + WebSocket for real-time updates.
- **Coexistence**: The existing Telegram Mini App remains operational for Telegram users. The web portal is a parallel entry point, not a replacement.

### 5.2 Authentication — Google OAuth2 (Gmail)

**Flow:**
1. User clicks "Sign in with Google" on the portal.
2. Redirect to Google OAuth2 consent screen.
3. User authorizes with their Google account.
4. Google redirects back to APIs with an auth code.
5. APIs exchanges the code for an ID token, extracts `google_id` + `email`.
6. If user exists (by `google_id`), log in. Otherwise, create new user.
7. Issue a session token (HTTP-only cookie).

**Coexistence with Telegram Mini App:** No forced migration. Telegram Mini App users continue using their `telegram_user_id` auth path. Web portal users use Google OAuth (`google_id`). The two identity systems run in parallel. Accounts are separate — a user can have both a Telegram-based account and a Google-based account independently.

### 5.3 Portal Page Structure

```
/                          → Landing page (Sign in with Google)
/dashboard                 → Assistant overview + platform cards
/connect/telegram          → Telegram setup (Quick Start or BYOB)
/connect/whatsapp          → WhatsApp QR pairing
/connect/discord           → Discord bot setup guide + token input
/connect/slack             → Slack app setup guide + token input
/settings                  → AI model, skills, billing
```

**Dashboard** — the central hub:

```
┌─────────────────────────────────────────────────────┐
│  My AI Assistant          Status: ● Running          │
│                                                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │Telegram │ │WhatsApp │ │Discord  │ │ Slack   │  │
│  │ ● On    │ │ ● On    │ │ ○ Off   │ │ ○ Off   │  │
│  │@mybot   │ │+1234... │ │         │ │         │  │
│  │[Manage] │ │[Manage] │ │[Connect]│ │[Connect]│  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│                                                      │
│  Settings: GPT-5 · 500 credits left · Pro plan      │
└─────────────────────────────────────────────────────┘
```

### 5.4 Real-Time Communication

WebSocket connection from portal to APIs for:
- WhatsApp QR code relay (QR images streamed in real-time).
- Container status changes (starting → running → error).
- Platform connection status (connected/disconnected).

---

## 6. Backend Architecture Changes

### 6.1 New Module: Channel Connection Manager

```
apis/src/domain/
├── channel-connections/               (new)
│   ├── service.ts                     # CRUD for channel_connections table
│   ├── validators/
│   │   ├── telegram.ts                # Validate Telegram bot token (getMe)
│   │   ├── discord.ts                 # Validate Discord bot token (users/@me)
│   │   └── slack.ts                   # Validate Slack tokens (auth.test)
│   ├── whatsapp-pairing.ts            # QR relay: portal <-> APIs WS <-> container RPC
│   ├── discord-invite.ts              # Generate Discord bot invite URL
│   └── status-monitor.ts             # Periodic health probe for all connected channels
├── platform-router/                   (refactored from telegram-router)
│   ├── router.ts                      # Generic inbound webhook routing
│   ├── telegram-inbound.ts            # Telegram webhook handler (for both QS and BYOB)
│   ├── telegram-proxy.ts             # Outbound Telegram API proxy (Quick Start only)
│   └── types.ts
├── container/                         (enhanced)
│   ├── orchestrator.ts                # Enhanced with multi-channel config
│   ├── config-builder.ts             # Generates OpenClaw config from channel_connections
│   └── ...
├── auth/                              (enhanced)
│   ├── google_login.ts                # New: Google OAuth2
│   ├── telegram_login.ts             # Existing (Mini App backward compat)
│   └── session.ts                     # Platform-agnostic session management
└── ...
```

### 6.2 Simplified Message Flow (BYOB = Direct)

Since all BYOB platforms use direct connections, the APIs service is **NOT in the message path** for WhatsApp, Discord, or Slack:

| Platform | Inbound | Outbound | APIs Role |
|----------|---------|----------|-----------|
| TG Quick Start | APIs receives webhook → forwards to container | Container → APIs proxy → TG API | Full proxy (existing) |
| TG BYOB | APIs receives webhook → forwards to container | Container → TG API directly | Inbound relay only |
| WhatsApp | WA servers → Container (Baileys WS) | Container → WA servers (Baileys) | None (QR pairing only) |
| Discord | Discord Gateway → Container (WS) | Container → Discord REST API | None |
| Slack | Slack → Container (Socket Mode WS) | Container → Slack Web API | None |

### 6.3 Container Config Builder Enhancement

The existing `buildAssistantOpenclawConfig()` (in `apis/src/domain/container/providers/shared/openclaw_config.ts`) generates a full OpenClaw config with `gateway`, `models`, `tools`, `commands`, `browser`, `cron`, `skills` sections — **all of this is reusable as-is**. The only change is the `channels` and `plugins` sections, which must now be built dynamically from the `channel_connections` table instead of hardcoding Telegram.

**Current** (Telegram-only):
```typescript
// openclaw_config.ts (simplified)
function buildAssistantOpenclawConfig(assistant, gatewayToken) {
  return {
    gateway: { /* reusable */ },
    models:  { /* reusable — LiteLLM providers */ },
    tools:   { /* reusable — exec, web, media, browser */ },
    channels: {
      telegram: { /* hardcoded Telegram config */ }  // ← ONLY THIS CHANGES
    },
    plugins: {
      entries: {
        telegram: { enabled: true },                  // ← AND THIS
        "telegram-api-proxy": { enabled: true },
        "platform-hooks": { enabled: true },
      }
    }
  };
}
```

**New** (multi-platform):
```typescript
function buildAssistantOpenclawConfig(
  assistant: AssistantRecord,
  connections: ChannelConnection[]    // ← NEW PARAMETER
): OpenClawConfig {
  // =========================================================
  // REUSED AS-IS from existing code:
  // =========================================================
  const gateway = buildGatewayConfig(assistant);        // existing
  const models  = buildModelConfig(assistant);          // existing (LiteLLM)
  const tools   = buildToolsConfig(assistant);          // existing
  const skills  = buildSkillsConfig(assistant);         // existing
  // ... browser, cron, commands, etc. — all existing

  // =========================================================
  // NEW: dynamic channels + plugins based on channel_connections
  // =========================================================
  const channels: ChannelsConfig = {};
  const pluginEntries: Record<string, { enabled: boolean }> = {
    "platform-hooks": { enabled: true },               // always enabled
    "litellm-vision-adapter": { enabled: true },       // always enabled
  };

  for (const conn of connections) {
    switch (conn.platform) {
      case 'telegram':
        if (conn.config.mode === 'quickstart') {
          channels.telegram = buildTelegramQuickStartConfig(conn);
          pluginEntries["telegram"] = { enabled: true };
          pluginEntries["telegram-api-proxy"] = { enabled: true };
        } else {
          channels.telegram = buildTelegramByobConfig(conn);
          pluginEntries["telegram"] = { enabled: true };
          // NO telegram-api-proxy for BYOB
        }
        break;

      case 'whatsapp':
        channels.whatsapp = {
          authDir: '/data/web/auth',
          dmPolicy: 'open',
          textChunkLimit: 4000,
        };
        break;

      case 'discord':
        channels.discord = {
          botToken: decrypt(conn.credentials).botToken,
          dm: { policy: 'open' },
          streaming: { mode: 'edit' },
        };
        break;

      case 'slack':
        const creds = decrypt(conn.credentials);
        channels.slack = {
          botToken: creds.botToken,
          appToken: creds.appToken,
          mode: 'socket',
          dm: { policy: 'open' },
          streaming: { mode: 'edit' },
        };
        break;
    }
  }

  return {
    gateway,           // reused
    models,            // reused (LiteLLM per-user key)
    tools,             // reused
    skills,            // reused
    channels,          // NEW: dynamic
    plugins: { entries: pluginEntries },  // NEW: dynamic
    // ... rest reused
  };
}
```

**Key point**: the `buildModelConfig()`, `buildToolsConfig()`, `buildSkillsConfig()` etc. are the existing functions that generate LiteLLM provider routing, tool permissions, exec settings, etc. They don't change at all.

### 6.4 Container Lifecycle on Channel Change

This leverages the **existing drift detection** in `ContainerOrchestrator`. When the config changes, `PINAI_OPENCLAW_CONFIG_SHA256` changes, and the orchestrator automatically detects it.

When a user connects or disconnects a platform:

1. **Update DB**: `channel_connections` row created/updated.
2. **Rebuild config**: Regenerate `OPENCLAW_CONFIG_B64` from all active connections → new SHA256 hash.
3. **Call `ensureAssistantContainer()`** (existing function):
   - Orchestrator compares config hash → detects drift → triggers `shouldRecreateAssistantMachine()`.
   - Existing logic: stop old machine → create new machine with updated config → probe → ready.
   - **All existing**: volume preservation, region fallback, retry logic, health probing.
4. **Notify portal**: Send status update via WebSocket (new; replaces Telegram notification for portal users).

**Timeline**: Container rebuild takes ~30-90 seconds (cold start). During this time, the portal shows "Updating..." status. Existing channels in the container are briefly offline.

**Future optimization**: Hot reload via container gateway RPC (`config.reload`) to avoid full restart when adding/removing a channel. This requires OpenClaw to support dynamic channel start/stop — possible but not yet verified.

### 6.5 API Endpoints

```
# Auth (Google OAuth2)
GET    /auth/google/url              # Get Google OAuth2 authorization URL
GET    /auth/google/callback         # Google OAuth2 redirect handler
POST   /auth/logout                  # End session
GET    /auth/me                      # Current user info

# Channel Connections
GET    /channels                     # List all platform connections + status

POST   /channels/telegram/connect    # { mode: "quickstart" } or { mode: "byob", botToken: "..." }
DELETE /channels/telegram/disconnect

POST   /channels/whatsapp/pair       # Initiate QR pairing → returns WebSocket ticket
DELETE /channels/whatsapp/disconnect

POST   /channels/discord/connect     # { botToken: "..." } → validates, returns invite URL
DELETE /channels/discord/disconnect

POST   /channels/slack/connect       # { botToken: "xoxb-...", appToken: "xapp-..." }
DELETE /channels/slack/disconnect

# Real-Time
GET    /channels/status              # Snapshot of all connection statuses
WS     /channels/ws                  # WebSocket for QR relay + live status updates

# Telegram Inbound (existing + enhanced)
POST   /webhook/telegram             # Quick Start shared bot webhook (existing)
POST   /webhook/telegram/:userId     # Per-user BYOB webhook endpoint (new)
```

---

## 7. Database Schema Evolution

```sql
-- Google OAuth identity
ALTER TABLE users
  ADD COLUMN google_id VARCHAR(255) UNIQUE,
  ADD COLUMN email VARCHAR(255) UNIQUE,
  ALTER COLUMN telegram_user_id DROP NOT NULL;

-- Channel connections (core new table)
CREATE TABLE channel_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assistant_id  UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  platform      VARCHAR(50) NOT NULL,  -- 'telegram' | 'whatsapp' | 'discord' | 'slack'
  status        VARCHAR(50) NOT NULL DEFAULT 'disconnected',
    -- 'connected' | 'disconnected' | 'pairing' | 'error'
  credentials   JSONB,       -- AES-256-GCM encrypted: { botToken, appToken, etc. }
  config        JSONB,       -- Platform-specific settings: { mode, dmPolicy, ... }
  metadata      JSONB,       -- Read-only info: { botUsername, teamName, phoneNumber, ... }
  connected_at  TIMESTAMPTZ,
  last_seen_at  TIMESTAMPTZ, -- Last successful health probe
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assistant_id, platform)
);

CREATE INDEX idx_channel_connections_status ON channel_connections(status);
```

**What `credentials` stores per platform (encrypted):**

| Platform | credentials JSONB |
|----------|------------------|
| Telegram (QS) | `{ mode: "quickstart" }` (no user token) |
| Telegram (BYOB) | `{ mode: "byob", botToken: "123:ABC..." }` |
| WhatsApp | `{}` (auth state on container disk, not in DB) |
| Discord | `{ botToken: "MTIz..." }` |
| Slack | `{ botToken: "xoxb-...", appToken: "xapp-..." }` |

**What `metadata` stores per platform (read-only, for display):**

| Platform | metadata JSONB |
|----------|---------------|
| Telegram | `{ botUsername: "mybot", botId: 123456 }` |
| WhatsApp | `{ phoneNumber: "+1234567890" }` |
| Discord | `{ botUsername: "MyBot#1234", botId: "123...", guilds: [...] }` |
| Slack | `{ teamName: "My Workspace", teamId: "T0123", botUserId: "U0123" }` |

### Credential Encryption

All tokens in `credentials` are encrypted at rest using AES-256-GCM. The encryption key is stored in Fly.io secrets (`CREDENTIAL_ENCRYPTION_KEY`), never in code.

---

## 8. Container Configuration Changes

### Example: User with all 4 platforms enabled

```jsonc
{
  "gateway": {
    "auth": { "token": "<per-user-gateway-token>" },
    "bind": "loopback"
  },
  "channels": {
    "telegram": {
      "botToken": "<user's own telegram bot token>",
      "webhookUrl": "https://pinclaw-api-dev.fly.dev/webhook/telegram/user_abc123",
      "webhookSecret": "<derived secret>",
      "streaming": { "mode": "edit", "blockMode": "partial" }
    },
    "whatsapp": {
      "authDir": "/data/web/auth",
      "dmPolicy": "open",
      "textChunkLimit": 4000
    },
    "discord": {
      "botToken": "<user's discord bot token>",
      "dm": { "policy": "open" },
      "streaming": { "mode": "edit" }
    },
    "slack": {
      "botToken": "<user's xoxb- token>",
      "appToken": "<user's xapp- token>",
      "mode": "socket",
      "dm": { "policy": "open" },
      "streaming": { "mode": "edit" }
    }
  },
  "plugins": [
    { "path": "/app/plugins/platform-hooks" }
  ],
  "models": {
    "primary": { "provider": "litellm", "model": "gpt-5" }
  }
}
```

Note: `telegram-api-proxy` plugin is **NOT** included for BYOB Telegram (the container calls Telegram API directly). It's only included for Quick Start mode.

### OpenClaw Image Changes

The Docker image must be rebuilt to include dependencies for all 4 channel plugins:

| Dependency | For | Current Status |
|------------|-----|---------------|
| `grammy` | Telegram | Already included |
| `@whiskeysockets/baileys` | WhatsApp | **Needs to be added** |
| `@buape/carbon` | Discord | **Needs to be added** |
| `@slack/bolt` | Slack | **Needs to be added** |

After image rebuild, update `OPENCLAW_IMAGE` secret to new `@sha256:...` digest.

### P0 Security

For BYOB mode, the tokens belong to the user, not the platform. A container breach exposes only that user's tokens. This is an acceptable risk level (same as OpenClaw's local deployment model).

The only P0 platform secret remaining is the **Telegram Quick Start shared bot token**, which continues to use the existing proxy mechanism.

---

## 9. Security Considerations

### 9.1 Credential Storage
- All platform tokens encrypted at rest (AES-256-GCM) in `channel_connections.credentials`.
- Encryption key in Fly.io secrets (`CREDENTIAL_ENCRYPTION_KEY`).
- Tokens pass to containers only via `OPENCLAW_CONFIG_B64` (decoded in memory on container startup).

### 9.2 BYOB Security Model
- User-owned tokens: if a container is compromised, only that user's bots are affected.
- Users can revoke their tokens at any time via the platform's developer portal.
- We never store tokens in plaintext (always encrypted in DB, base64-encoded in container config).

### 9.3 WhatsApp Session Security
- Baileys auth state (session keys) stored on container's encrypted Fly volume.
- Auth state never leaves the container (not backed up to DB).
- Each user has their own isolated Fly machine.
- User can revoke via "Linked Devices" in WhatsApp phone settings.

### 9.4 Web Portal Authentication (Google OAuth2)
- Google ID tokens verified server-side against Google's public keys.
- Session tokens: HTTP-only, Secure, SameSite=Strict cookies.
- CSRF protection on all state-changing endpoints.
- Rate limiting on auth endpoints.
- Google OAuth `client_secret` in Fly.io secrets.

---

## 10. Implementation Phases

### Phase 0: Foundation (Weeks 1-3)

**Goal:** Google OAuth identity + standalone web portal + decouple from Telegram-only

Key principle: keep existing Telegram Quick Start working (backward compat) while adding the new multi-platform layer on top.

- [ ] Database migration: `users` adds `google_id` + `email`, `telegram_user_id` becomes nullable.
- [ ] Google OAuth2 login (server-side token exchange + session cookies).
- [ ] Web portal scaffolding (React + Vite + Tailwind, deployed to Fly.io).
- [ ] Portal: Google Sign-In, dashboard shell, routing.
- [ ] `channel_connections` table + encrypted credential storage (`CREDENTIAL_ENCRYPTION_KEY`).
- [ ] Channel Connection Manager service (CRUD, validators).
- [ ] Refactor `buildAssistantOpenclawConfig()`: add `connections` parameter, build `channels` dynamically. **Reuse all existing gateway/models/tools/skills config generation.**
- [ ] Refactor `ensureAssistantContainer()` call sites: pass `channel_connections` instead of hardcoded Telegram config. **Reuse existing orchestrator, drift detection, Fly machine creation.**
- [ ] Refactor `subscriptionGuard`: lookup by `user.id` instead of `telegram_user_id`.
- [ ] Refactor payment metadata: `user_id` (UUID) instead of `telegram_user_id`.
- [ ] Telegram BYOB: accept user's bot token, register per-user webhook, generate config without `telegram-api-proxy`.
- [ ] Portal: Telegram connect page (Quick Start + BYOB toggle).
- [ ] Verify: existing Telegram Quick Start still works unchanged after refactor.

### Phase 1: WhatsApp (Weeks 4-7)

**Goal:** WhatsApp QR pairing + direct messaging via cloud container

- [ ] OpenClaw image rebuild: add `@whiskeysockets/baileys` + WhatsApp channel plugin.
- [ ] QR code relay pipeline: Portal WebSocket ↔ APIs ↔ Container gateway RPC.
- [ ] Portal: WhatsApp connect page (QR display, status indicator, disconnect).
- [ ] Config builder: generate `channels.whatsapp` section.
- [ ] Session persistence on Fly volume (`/data/web/auth/`).
- [ ] Health monitoring: periodic WhatsApp connection status probe.
- [ ] Disconnect/logout flow.
- [ ] E2E testing on Fly.io: pair → send message → receive AI reply → disconnect.

### Phase 2: Discord (Weeks 8-10)

**Goal:** Discord bot via BYOB token

- [ ] Portal: Discord connect page (step-by-step guide + token input + invite URL).
- [ ] APIs: Discord token validation (`GET /users/@me`), invite URL generation.
- [ ] Config builder: generate `channels.discord` section.
- [ ] OpenClaw image: include `@buape/carbon` + Discord channel plugin.
- [ ] Container rebuild on connect/disconnect.
- [ ] Status monitoring.
- [ ] E2E testing: connect → bot joins server → DM/channel reply → disconnect.

### Phase 3: Slack (Weeks 11-13)

**Goal:** Slack bot via BYOB tokens (Socket Mode)

- [ ] Portal: Slack connect page (step-by-step guide + two token inputs).
- [ ] APIs: Slack token validation (`auth.test`), app token format check.
- [ ] Config builder: generate `channels.slack` section (Socket Mode).
- [ ] OpenClaw image: include `@slack/bolt` + Slack channel plugin.
- [ ] Container rebuild on connect/disconnect.
- [ ] Status monitoring.
- [ ] E2E testing: connect → bot receives messages → AI reply → disconnect.

### Phase 4: Polish & Production (Weeks 14-17)

**Goal:** Production readiness

- [ ] Dashboard: unified platform cards with live status.
- [ ] Error recovery: re-pair WhatsApp, re-enter Discord/Slack tokens.
- [ ] Container sizing: profile memory with 4 channels, upgrade specs if needed.
- [ ] Billing integration.
- [ ] Rate limiting + abuse prevention.
- [ ] Production environment setup (CI/CD, separate Fly apps).
- [ ] Security audit: credential handling, P0 verification.
- [ ] Load testing.

---

## 11. Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Baileys breaks (WhatsApp protocol change) | Medium | High | Monitor Baileys issues; fallback to disable WA; consider official WA Business API |
| WhatsApp bans cloud IPs | Medium | High | Residential proxies; rate limiting; WA Business Cloud API as alternative |
| BYOB setup too complex for non-technical users | Medium | Medium | Interactive step-by-step guides with screenshots; video tutorials |
| Container memory pressure with 4 channels | Medium | Medium | Profile per-channel memory; bump to `shared-cpu-2x`; lazy-load channels |
| User token revocation goes undetected | Low | Low | Periodic health probes; portal shows stale status within 5 minutes |
| Credential breach in DB | Low | Critical | AES-256-GCM encryption; key rotation; minimal exposure |
| QR relay latency (WhatsApp) | Low | Medium | Direct WebSocket pipeline; QR refresh every 20s handled automatically |

---

## 12. Decisions Log (Resolved)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | **Web portal hosting** | **Fly.io** | Same platform as APIs; simplifies deployment and internal networking. |
| 2 | **Portal domain** | **Main domain** (e.g. `pinclaw.com`) | Professional look; Google OAuth redirect URI and CORS set to this domain. |
| 3 | **Existing Mini App** | **Keep both in parallel** | Telegram Mini App continues for existing Telegram users. Web portal is the new entry point for multi-platform users. Both coexist indefinitely. |
| 4 | **Identity migration** | **No migration — parallel identity systems** | Telegram Mini App users keep their `telegram_user_id` path. Web portal users get `google_id` path. Two systems run in parallel. No forced migration. If a user wants to use both, they can (but accounts are separate unless manually linked in the future). |
| 5 | **Pricing** | **All platforms included in existing plans** | Basic/Pro/Max prices unchanged. Users can connect any/all 4 platforms at no extra cost. Credits are consumed by AI usage regardless of which platform the message came from. |
| 6 | **Container sizing** | **Keep `shared-cpu-1x` (256MB) for now** | Start with current specs. Monitor memory usage after adding channels. Upgrade to `shared-cpu-2x` only if OOM or performance issues are observed. |

## 13. Resolved Follow-Up Items

| # | Item | Decision |
|---|------|----------|
| 1 | WhatsApp Business API as Baileys alternative | **Not needed.** Baileys only. |
| 2 | BYOB UX optimization (Discord invite URL auto-gen, Slack manifest import) | **Post-MVP.** Iterate after core flow works. |
| 3 | Google Cloud OAuth credentials setup | **After code is written.** Step-by-step setup guide will be provided at that time. |

**All architectural and product decisions are finalized. Ready to begin Phase 0 implementation.**

---

## Appendix A: OpenClaw Channel Plugin Interface

All channels implement the `ChannelPlugin` interface:

```typescript
type ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  gateway?: {
    startAccount: (ctx) => Promise<unknown>;
    stopAccount: (ctx) => Promise<void>;
    loginWithQrStart?: (params) => Promise<QrResult>;
    loginWithQrWait?: (params) => Promise<LoginResult>;
    logoutAccount?: (ctx) => Promise<LogoutResult>;
  };
  outbound?: {
    sendText: (ctx, text) => Promise<void>;
    sendPayload: (ctx, payload) => Promise<void>;
    sendMedia: (ctx, media) => Promise<void>;
  };
  config: { resolveAccount: (config) => ResolvedAccount };
  pairing?: ChannelPairingAdapter;
};
```

## Appendix B: Full Message Flow Summary

| Platform | Inbound Path | Outbound Path | APIs in message path? |
|----------|-------------|---------------|----------------------|
| TG Quick Start | TG API → APIs webhook → Container(:8787) | Container → APIs proxy → TG API | Yes (both directions) |
| TG BYOB | TG API → APIs webhook/:userId → Container(:8787) | Container → TG API (direct) | Inbound only |
| WhatsApp | WA servers → Container (Baileys WS) | Container (Baileys) → WA servers | No |
| Discord | Discord Gateway WS → Container | Container → Discord REST API | No |
| Slack | Slack Socket Mode WS → Container | Container → Slack Web API | No |

## Appendix C: References

- OpenClaw source: `openclaw-2026.3.13-1/` (local reference copy)
- OpenClaw upstream submodule: `pinai-openclaw/external/openclaw/` (v2026.3.8, read-only)
- Current container provisioning: `apis/src/domain/container/`
- Current Telegram routing: `apis/src/domain/telegram-router/`
- Baileys library: `@whiskeysockets/baileys` (WhatsApp Web protocol)
- Discord Carbon: `@buape/carbon` (Discord bot framework)
- Slack Bolt: `@slack/bolt` (Slack app framework)
