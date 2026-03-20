// services/monday.js — All Monday.com functions

import { withRetry, bestName } from '../utils/helpers.js';
import { updateTwentyInquiry } from './twenty.js';

const MONDAY_COLS = {
  phone:        'text_mm1dj5cb',
  tier:         'color_mm1dx2x3',
  source:       'text_mm1d77a4',
  reference:    'text_mm1dpm0d',
  language:     'color_mm1dqhvs',
  conversation: 'long_text_mm1d52b4',
  status:       'status',
  date:         'date4'
};

export async function mondayQuery(query, variables = {}) {
  if (!process.env.MONDAY_API_KEY || !process.env.MONDAY_BOARD_ID) return null;
  try {
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': process.env.MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (json.errors) { console.error('[Monday] GraphQL errors:', JSON.stringify(json.errors)); return null; }
    return json.data;
  } catch (err) { console.error('[Monday] Request failed:', err.message); return null; }
}

export async function createMondayItem(phone, tier, mem, fields) {
  if (!process.env.MONDAY_API_KEY || !process.env.MONDAY_BOARD_ID) return null;
  const cleanPhone  = phone.replace('whatsapp:', '');
  const tierLabel   = tier === 1 ? 'AOG Emergency' : 'Freight Inquiry';
  const langLabel   = mem.language === 'es' ? 'Spanish' : mem.language === 'pt' ? 'Portuguese' : 'English';
  const displayName = bestName(mem, fields, cleanPhone);
  const itemName    = mem.refNumber ? `${mem.refNumber} — ${displayName}` : displayName;
  const today       = new Date().toISOString().split('T')[0];
  const now         = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  // Build enriched transcript with new fields appended
  const transcript  = mem.messages.map(m => `${m.role === 'user' ? 'Customer' : 'Patty'}: ${m.content}`).join('\n');
  const fieldSummary = buildFieldSummary(fields);
  const fullConversation = fieldSummary ? `${transcript}\n\n---\n${fieldSummary}` : transcript;

  const columnValues = JSON.stringify({
    [MONDAY_COLS.phone]:        cleanPhone,
    [MONDAY_COLS.reference]:    mem.refNumber || '',
    [MONDAY_COLS.tier]:         { label: tierLabel },
    [MONDAY_COLS.language]:     { label: langLabel },
    [MONDAY_COLS.source]:       'WhatsApp Bot',
    [MONDAY_COLS.status]:       { label: 'Working on it' },
    [MONDAY_COLS.date]:         { date: today },
    [MONDAY_COLS.conversation]: `[${now} ET]\n\n${fullConversation}`
  });

  const result = await withRetry(() => mondayQuery(
    `mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
    }`,
    { boardId: process.env.MONDAY_BOARD_ID, itemName, columnValues }
  ));
  const itemId = result?.create_item?.id || null;
  if (itemId) console.log(`[Monday] Created item ${itemId} for ${cleanPhone}`);
  return itemId;
}

export async function updateMondayItem(itemId, phone, mem, finalTranscript) {
  if (!process.env.MONDAY_API_KEY || !itemId) return;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  await mondayQuery(
    `mutation AddUpdate($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId, body: `Conversation closed — ${now} ET\n\n${finalTranscript}` }
  );
  await mondayQuery(
    `mutation UpdateStatus($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`,
    { boardId: process.env.MONDAY_BOARD_ID, itemId, columnValues: JSON.stringify({ [MONDAY_COLS.status]: { label: 'Done' } }) }
  );
  console.log(`[Monday] Updated item ${itemId} with final transcript`);
}

export async function enrichRecords(mem, phone, fields, isEscalation) {
  const cleanPhone = phone.replace('whatsapp:', '');
  const transcript = mem.messages.map(m => `${m.role === 'user' ? 'Customer' : 'Patty'}: ${m.content}`).join('\n');
  const newName    = bestName(mem, fields, cleanPhone);
  const fieldSummary = buildFieldSummary(fields);
  const fullConversation = fieldSummary ? `${transcript}\n\n---\n${fieldSummary}` : transcript;

  // ── Update Twenty ──
  if (mem.twentyInquiryId) {
    const updates = { transcript };
    if (fields?.origin)          updates.origin          = fields.origin;
    if (fields?.destination)     updates.destination     = fields.destination;
    if (fields?.commodity)       updates.commodity       = fields.commodity;
    if (fields?.weightDims)      updates.weightDims      = fields.weightDims;
    if (fields?.hazmat)          updates.hazmat          = fields.hazmat;
    if (fields?.transportMode)   updates.transportMode   = fields.transportMode;
    if (fields?.pickupAddress)   updates.pickupAddress   = fields.pickupAddress;
    if (fields?.deliveryAddress) updates.deliveryAddress = fields.deliveryAddress;
    if (newName)                 updates.name            = newName;
    if (isEscalation) { updates.tier = 'AOG_EMERGENCY'; updates.escalated = true; updates.status = 'NEW'; }
    await updateTwentyInquiry(mem.twentyInquiryId, updates);
  }

  // ── Update Monday ──
  if (mem.mondayItemId) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const colUpdates = { [MONDAY_COLS.conversation]: `[${now} ET]\n\n${fullConversation}` };
    if (isEscalation) {
      colUpdates[MONDAY_COLS.tier]   = { label: 'AOG Emergency' };
      colUpdates[MONDAY_COLS.status] = { label: 'Working on it' };
    }
    if (newName && mem.refNumber) colUpdates['name'] = `${mem.refNumber} — ${newName}`;

    await mondayQuery(
      `mutation UpdateItem($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`,
      { boardId: process.env.MONDAY_BOARD_ID, itemId: mem.mondayItemId, columnValues: JSON.stringify(colUpdates) }
    );
    if (newName && mem.refNumber) console.log(`[Monday] Renamed item: ${mem.refNumber} — ${newName}`);

    if (isEscalation) {
      await mondayQuery(
        `mutation AddUpdate($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
        { itemId: mem.mondayItemId, body: `ESCALATED TO AOG\nRef: ${mem.refNumber}\n\n${fullConversation}` }
      );
      console.log(`[Monday] Escalation update for item ${mem.mondayItemId}`);
    }
  }
}

// ── Helper: build a readable field summary block for Monday conversation column ──
function buildFieldSummary(fields) {
  if (!fields) return null;
  const lines = [];
  if (fields.hazmat)          lines.push(`Hazmat / DG: ${fields.hazmat}`);
  if (fields.transportMode)   lines.push(`Mode / Modo: ${fields.transportMode}`);
  if (fields.pickupAddress)   lines.push(`Pickup / Recogida: ${fields.pickupAddress}`);
  if (fields.deliveryAddress) lines.push(`Delivery / Entrega: ${fields.deliveryAddress}`);
  return lines.length > 0 ? lines.join('\n') : null;
}
