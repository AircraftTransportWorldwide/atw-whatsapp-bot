# ATW WhatsApp Bot — Patty
**Version:** v10.33 | **Status:** Production | **Updated:** March 2026

> Patty is a multilingual freight logistics assistant for Aircraft Transport Worldwide (ATW). She runs 24/7 on WhatsApp, handles AOG emergencies, qualifies freight inquiries, and integrates with CRM, project management, and communication tools — automatically.

---

## Table of Contents
- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Services & Integrations](#services--integrations)
- [Redis Memory Schema](#redis-memory-schema)
- [Inquiry Qualification Logic](#inquiry-qualification-logic)
- [Tier Classification](#tier-classification)
- [Email Alerts](#email-alerts)
- [Background Scanners](#background-scanners)
- [Agent Takeover](#agent-takeover)
- [Security](#security)
- [Deployment](#deployment)
- [Pre-Launch Checklist](#pre-launch-checklist)
- [Pending Items](#pending-items)
- [Key Contacts](#key-contacts)

---

## Overview

Patty is deployed on Railway and connected to ATW's WhatsApp Business number `+1 (305) 697-2789` via Twilio. She responds to inbound inquiries, classifies them by urgency, extracts shipment details, creates records in Twenty CRM and Monday.com, mirrors conversations to Chatwoot for agent visibility, and sends bilingual email alerts to the operations team.

**What makes Patty different from a generic chatbot:**
- Detects and responds in any language automatically (20+ languages supported)
- Never uses bullet points, markdown, or emojis — pure conversational prose
- Recognizes returning customers by name and references their history
- Does not create CRM/Monday records until the conversation proves real freight intent
- Sends a professional confirmation summary once all shipment fields are collected
- Triggers SLA breach alerts if an AOG emergency goes unattended for 15 minutes
- Sends a daily briefing email to the ops team every morning at 8am Miami time

---

## Architecture

```
WhatsApp Customer
      │
      ▼
   Twilio (webhook validation)
      │
      ▼
ATW WhatsApp Bot (Railway — Node.js)
      │
      ├─► Redis          (conversation memory, 24hr TTL)
      ├─► Claude API     (Patty's intelligence + field extraction + translation)
      ├─► Twenty CRM     (contacts + inquiry records)
      ├─► Monday.com     (ATW Bot Inquiries board)
      ├─► Chatwoot       (conversation mirror + agent takeover)
      └─► Resend         (bilingual email alerts)
```

**7 Railway services total:**
| Service | Description |
|---|---|
| atw-whatsapp-bot | Main bot — Express server, orchestration |
| Twenty CRM | Self-hosted CRM (v0.60.7) |
| Chatwoot web | Customer communication platform |
| Chatwoot Sidekiq | Background job processor |
| PostgreSQL (Chatwoot) | postgres-yPqy |
| PostgreSQL (Twenty) | Postgres-kcD2 |
| Redis | Shared memory store |

---

## Features

### Core
- ✅ Multilingual — detects and responds in any language (20+ supported)
- ✅ Tier classification — AOG Emergency / Standard Freight / General
- ✅ Negation-aware — "not AOG" correctly classifies as Tier 2
- ✅ Effective tier — conversations never downgrade mid-session
- ✅ Reference number generated on Tier 1/2, sent once in customer's language
- ✅ TSA/DHS compliance disclaimer sent on first message, translated dynamically
- ✅ Confirmation summary sent when all 4 fields are collected
- ✅ Returning customer recognition — greets by name, references history
- ✅ Technical fallback — instructs customer to call +1 (305) 456-8400 if API fails

### Qualification Filter
- ✅ Inquiries only create CRM/Monday records when they demonstrate real freight intent
- ✅ Test/novelty openers (hi, hello, test, prueba) are flagged and deferred
- ✅ Test conversations that turn real are automatically graduated

### CRM & Operations
- ✅ Twenty CRM — contact dedup, inquiry creation, mid-conversation enrichment
- ✅ Monday.com — item creation, conversation updates, item rename on company detection
- ✅ Chatwoot — full message mirroring, attachment forwarding, profile notes

### Alerts & Monitoring
- ✅ Email alerts — bilingual (EN/ES), Tier-color-coded, with full transcript
- ✅ Idle email — fires 5 minutes after last message on qualified inquiries
- ✅ SLA breach email — fires if AOG goes unattended for 15 minutes
- ✅ Live agent email — fires immediately when customer requests a human
- ✅ Morning briefing — daily digest at 8am Miami time

### Security
- ✅ Twilio signature validation on every webhook
- ✅ Input sanitization — HTML stripped, 1000 char limit
- ✅ Rate limiting — 15 messages per 10 minutes per number
- ✅ Duplicate message protection via SID dedup
- ✅ Retry logic — 3 attempts with exponential backoff

---

## Project Structure

```
server.js                  ← Express routes + orchestration
services/
  claude.js                ← callClaude, detectLanguage, extractFields,
                              classifyTier, detectLiveAgentRequest,
                              generateEmailSummary, buildSystemPrompt,
                              translateSystemMessage
  twenty.js                ← findOrCreateContact, getInquiryHistory,
                              createTwentyInquiry, updateTwentyInquiry
  monday.js                ← createMondayItem, updateMondayItem,
                              enrichRecords, mondayQuery
  chatwoot.js              ← sendChatwootMessage, findOrCreateContact,
                              findOrCreateConversation, postProfileNote,
                              forwardAttachmentToChatwoot
  email.js                 ← sendEmailAlert (bilingual, tier-colored)
  morning.js               ← sendMorningBriefing (daily 8am digest)
utils/
  redis.js                 ← all Redis helpers + connectRedis()
  helpers.js               ← withRetry, sanitizeInput,
                              generateRefNumber, bestName
```

**When something breaks, open only the relevant file:**
- Patty's behavior or tone → `services/claude.js`
- Twenty CRM issue → `services/twenty.js`
- Monday issue → `services/monday.js`
- Email template → `services/email.js`
- Morning briefing → `services/morning.js`
- Redis/memory → `utils/redis.js`

---

## Environment Variables

Set in Railway → atw-whatsapp-bot service:

```env
CLAUDE_API_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_WHATSAPP_NUMBER=whatsapp:+13056972789
RESEND_API_KEY
CHATWOOT_API_URL=https://chatwoot-production-2de7.up.railway.app
CHATWOOT_API_TOKEN
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=4
TWENTY_API_URL=https://twenty-production-5ec5.up.railway.app
TWENTY_API_KEY
MONDAY_API_KEY
MONDAY_BOARD_ID=18403880179
REDIS_URL=redis://default:...@redis.railway.internal:6379
WEBHOOK_BASE_URL=https://atw-whatsapp-bot-production.up.railway.app
```

---

## Services & Integrations

### Twilio / WhatsApp
- **Number:** `+1 (305) 697-2789`
- **Account SID:** `AC3...2...7d...34e...250...dcb...6`
- **Webhook:** `POST /webhook`
- Twilio signature is validated on every request

### Twenty CRM
- **URL:** `https://twenty-production-5ec5.up.railway.app`
- **Version:** v0.60.7
- Phone search uses last 10 digits to match any formatting
- Contact creation uses real WhatsApp display name immediately

### Monday.com
- **Board:** ATW Bot Inquiries
- **Board ID:** `18403880179`
- **Account:** Diamond Aircraft (temporary — pending migration to ATW account)
- Column IDs stored in `MONDAY_COLS` constant in `services/monday.js`
- Status columns use `{ label: "Exact Label Text" }` format

### Chatwoot
- **URL:** `https://chatwoot-production-2de7.up.railway.app`
- **Version:** v3.13.0 (pinned — do not upgrade, pgvector incompatibility)
- **Inbox ID:** 4 | **Account ID:** 1
- Agent commands: `#takeover` to pause bot, `#done` to resume

### Resend
- **From:** `ATW Bot <onboarding@resend.dev>`
- **To:** `digital@atwcargo.com`
- DNS verification pending to unlock `laura@atwcargo.com`

### Redis
- **Internal URL:** `redis://default:...@redis.railway.internal:6379`
- **TTL:** 24 hours per conversation session

---

## Redis Memory Schema

```javascript
{
  messages: [],            // last 20 messages (10 exchanges)
  customerName: null,      // from Twenty CRM contact
  profileName: null,       // from Twilio ProfileName
  twentyContactId: null,
  twentyInquiryId: null,
  inquiryCreated: false,
  emailSent: false,
  mondayItemId: null,
  language: 'en',          // detected ISO 639-1 code
  highestTier: 3,          // tracks escalation, never downgrades
  refNumber: null,         // ATW-YYMMDD-XXXX
  refSentToCustomer: false,
  lastMessageAt: null,     // timestamp for idle email scanner
  liveAgentRequested: false,
  disclaimerSent: false,
  inquiryQualified: false, // true when real freight intent confirmed
  isTestConversation: false,
  confirmationSent: false,
  aogCreatedAt: null,      // SLA clock start for AOG
  slaAlertSent: false,
  chatwootConvId: null,
  lastFields: {}           // latest extracted fields for scanners
}
```

---

## Inquiry Qualification Logic

CRM records and email alerts are only created once a conversation passes the qualification threshold. This prevents test messages and novelty openers from polluting the Monday board and inbox.

**Qualification requires:** Tier 1 or 2 AND at least 2 of:
- Origin mentioned
- Destination mentioned
- Commodity mentioned
- Weight/dimensions mentioned
- 3 or more user messages sent

```javascript
function isQualifiedInquiry(effectiveTier, fields, messageCount) {
  if (effectiveTier > 2) return false;
  let signals = 0;
  if (fields?.origin)      signals++;
  if (fields?.destination) signals++;
  if (fields?.commodity)   signals++;
  if (fields?.weightDims)  signals++;
  if (messageCount >= 3)   signals++;
  return signals >= 2;
}
```

---

## Tier Classification

| Tier | Label | Description |
|---|---|---|
| 1 | AOG Emergency | Aircraft on ground, critical aviation emergency, needs parts immediately |
| 2 | Standard Freight | Cargo shipment, quote request, dangerous goods, oversized, ocean/air freight |
| 3 | General | Greetings, questions, unrelated topics |

- Tier 1/2 triggers: ref number generation, CRM record, Monday item, email alert
- Tier 3 only: Patty responds, no records created
- `effectiveTier` = `Math.min(currentTier, highestTier)` — never downgrades

---

## Email Alerts

All emails sent to `digital@atwcargo.com` via Resend. Bilingual (EN/ES).

| Type | Trigger | Color |
|---|---|---|
| Tier 1 — AOG Emergency | Idle 5min or #done | Red `#CC0000` |
| Tier 2 — Standard Inquiry | Idle 5min or #done | Blue `#0055A4` |
| Live Agent Requested | Immediate | Orange `#FF6600` |
| SLA Breach | AOG unattended 15min | Dark Red `#8B0000` |

Email includes: bilingual subject, bilingual badge, EN summary, ES summary, all extracted fields, full conversation transcript.

---

## Background Scanners

A single `setInterval` runs every 60 seconds and handles three jobs:

**1. Idle Email Scanner**
Sends email alert when a qualified conversation has been inactive for 5+ minutes and no email has been sent yet.

**2. SLA Breach Scanner**
Monitors Tier 1 AOG inquiries. If 15 minutes pass without a `#takeover` from an agent, fires a dark red SLA breach alert email.

**3. Morning Briefing**
Fires once between 08:00–08:09 AM Miami time. Collects all qualified inquiries from the past 24 hours and sends a structured digest email, AOG inquiries listed first.

---

## Agent Takeover

Agents interact via Chatwoot using two commands:

| Command | Action |
|---|---|
| `#takeover` | Pauses bot. Agent has full control of the conversation. |
| `#done` | Resumes bot. Fires final Monday update, Twenty update, and email if not already sent. |

Auto-resume: if an agent takes over but sends no message for 2 hours, the bot resumes automatically.

---

## Security

- **Twilio signature validation** — every `/webhook` POST is verified via HMAC
- **Rate limiting** — 15 messages per 10 minutes per phone number
- **Input sanitization** — HTML stripped, max 1000 characters
- **SID deduplication** — prevents double-processing of retried Twilio webhooks
- **Chatwoot deduplication** — prevents echo loops on outgoing messages
- **Retry with backoff** — 3 attempts, exponential backoff on all external API calls

---

## Deployment

**Stack:** Node.js (ESM), Railway, GitHub auto-deploy

```bash
# Deploy flow
git add .
git commit -m "vX.XX — description"
git push origin main
# Railway auto-deploys in ~60 seconds
```

**Confirm deployment:**
Check Railway logs for:
```
[Redis] Connected
[Boot] ATW Bot vX.XX running on port 8080
```

**5 success log lines to verify full system health:**
```
[Twenty] Found contact: <name>     ← or Created on first message
[Twenty] Created inquiry: <id>
[Monday] Created item <id>
[Email] Tier X alert sent
[Ref] Generated ATW-XXXXXX
```

---

## Pre-Launch Checklist

- [ ] Delete test rows on Monday board
- [ ] Confirm `WEBHOOK_BASE_URL` env var is set
- [ ] Run end-to-end test from a fresh number
- [ ] Confirm 5 success log lines in Railway
- [ ] Verify email received at digital@atwcargo.com

---

## Pending Items

| Item | Priority |
|---|---|
| A2P 10DLC registration (Twilio) | High |
| Meta Business Verification | ✅ Done — Mar 6, 2026 |
| DNS verification for Resend (laura@atwcargo.com) | Medium |
| Migrate Monday board to ATW's own account | Medium |
| SLA SMS alert to Laura's cell | Medium |
| Bot stop/start endpoints with secret key | Medium |
| Email distribution list | Medium |
| ATW training manual → Patty's system prompt | Low |

---

## Key Contacts

| Person | Role |
|---|---|
| Jose Miguel | Sole technical operator |
| Laura | Business owner / senior stakeholder |
| Patty | Bot persona (Claude Sonnet 4) |
| digital@atwcargo.com | Ops email alert recipient |

**ATW Main Office:** +1 (305) 456-8400  
**ATW WhatsApp Bot:** +1 (305) 697-2789  
**Website:** atwcargo.com  
**Bot URL:** https://atw-whatsapp-bot-production.up.railway.app  
**Chatwoot:** https://chatwoot-production-2de7.up.railway.app
