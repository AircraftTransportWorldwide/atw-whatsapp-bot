// services/chatwoot.js — All Chatwoot functions

import FormData from 'form-data';
import fetch from 'node-fetch';

const url     = () => process.env.CHATWOOT_API_URL;
const token   = () => process.env.CHATWOOT_API_TOKEN;
const account = () => process.env.CHATWOOT_ACCOUNT_ID || '1';
const inbox   = () => process.env.CHATWOOT_INBOX_ID   || '4';

export async function sendChatwootMessage(convId, content, type = 'outgoing', isPrivate = false) {
  try {
    await fetch(`${url()}/api/v1/accounts/${account()}/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': token() },
      body: JSON.stringify({ content, message_type: type, private: isPrivate })
    });
  } catch (err) { console.error('[Chatwoot] Message error:', err.message); }
}

export async function findOrCreateChatwootContact(phone, name) {
  const cleanPhone = phone.replace('whatsapp:', '');
  try {
    const search = await fetch(
      `${url()}/api/v1/accounts/${account()}/contacts/search?q=${encodeURIComponent(cleanPhone)}&include_contacts=true`,
      { headers: { 'api_access_token': token() } }
    );
    const data = await search.json();
    if (data?.payload?.length > 0) return data.payload[0].id;
    const create = await fetch(`${url()}/api/v1/accounts/${account()}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': token() },
      body: JSON.stringify({ name: name || cleanPhone, phone_number: cleanPhone })
    });
    const created = await create.json();
    return created?.id || null;
  } catch (err) { console.error('[Chatwoot] Contact error:', err.message); return null; }
}

export async function findOrCreateChatwootConversation(contactId) {
  try {
    const convs = await fetch(
      `${url()}/api/v1/accounts/${account()}/contacts/${contactId}/conversations`,
      { headers: { 'api_access_token': token() } }
    );
    const data = await convs.json();
    const open  = data?.payload?.find(c => c.status === 'open' && c.inbox_id === parseInt(inbox()));
    if (open) return open.id;
    const create = await fetch(`${url()}/api/v1/accounts/${account()}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_access_token': token() },
      body: JSON.stringify({ inbox_id: parseInt(inbox()), contact_id: contactId })
    });
    const created = await create.json();
    return created?.id || null;
  } catch (err) { console.error('[Chatwoot] Conversation error:', err.message); return null; }
}

export async function postChatwootProfileNote(chatwootConvId, contact, phone, inquiryHistory) {
  if (!chatwootConvId) return;
  const cleanPhone = phone.replace('whatsapp:', '');
  const twentyUrl  = `${process.env.TWENTY_API_URL}/objects/inquiries`;
  const lines      = ['CUSTOMER PROFILE — Twenty CRM', `Phone: ${cleanPhone}`];
  if (contact.name) lines.push(`Name: ${contact.name}`);
  else lines.push('Name: Unknown (new contact)');
  if (inquiryHistory.length > 0) {
    const aogCount = inquiryHistory.filter(i => i.tier === 'AOG_EMERGENCY').length;
    lines.push(`Past inquiries: ${inquiryHistory.length}${aogCount > 0 ? ` (${aogCount} AOG)` : ''}`);
    const last = inquiryHistory[0];
    const date = new Date(last.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    lines.push(`Last inquiry: ${last.referenceNumber || '---'} on ${date}`);
    if (last.commodity)   lines.push(`Commodity: ${last.commodity}`);
    if (last.origin)      lines.push(`Origin: ${last.origin}`);
    if (last.destination) lines.push(`Destination: ${last.destination}`);
  } else {
    lines.push('Past inquiries: 0');
    lines.push('Status: First contact');
  }
  lines.push(`View in Twenty: ${twentyUrl}`);
  await sendChatwootMessage(chatwootConvId, lines.join('\n'), 'outgoing', true);
  console.log(`[Chatwoot] Posted profile note for ${cleanPhone}`);
}

export async function forwardAttachmentToChatwoot(chatwootConvId, mediaUrl, mediaType, caption) {
  try {
    const mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64') }
    });
    if (!mediaRes.ok) { console.error('[Attachment] Twilio media fetch failed:', mediaRes.status); return; }
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const ext    = (mediaType || 'application/octet-stream').split('/')[1] || 'bin';
    const fd     = new FormData();
    fd.append('content', caption || 'Customer sent an attachment.');
    fd.append('message_type', 'incoming');
    fd.append('attachments[]', buffer, { filename: `attachment.${ext}`, contentType: mediaType });
    const res = await fetch(
      `${url()}/api/v1/accounts/${account()}/conversations/${chatwootConvId}/messages`,
      { method: 'POST', headers: { 'api_access_token': token(), ...fd.getHeaders() }, body: fd }
    );
    if (res.ok) console.log('[Attachment] Forwarded to Chatwoot');
    else console.error('[Attachment] Chatwoot upload failed:', res.status);
  } catch (err) { console.error('[Attachment] Failed:', err.message); }
}
