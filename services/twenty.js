// services/twenty.js — All Twenty CRM functions

import { setTwentyCache } from '../utils/redis.js';
import { withRetry, bestName } from '../utils/helpers.js';

async function twentyQuery(query, variables = {}) {
  if (!process.env.TWENTY_API_URL || !process.env.TWENTY_API_KEY) return null;
  try {
    const res = await fetch(`${process.env.TWENTY_API_URL}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TWENTY_API_KEY}`
      },
      body: JSON.stringify({ query, variables })
    });
    const json = await res.json();
    if (json.errors) { console.error('[Twenty] GraphQL errors:', JSON.stringify(json.errors)); return null; }
    return json.data;
  } catch (err) { console.error('[Twenty] Request failed:', err.message); return null; }
}

export async function findOrCreateContact(phone, name) {
  const cleanPhone = phone.replace('whatsapp:', '');
  const digitsOnly = cleanPhone.replace(/\D/g, '');
  const last10     = digitsOnly.slice(-10);

  const searchResult = await twentyQuery(`
    query FindPeople($filter: PersonFilterInput) {
      people(filter: $filter, orderBy: { createdAt: AscNullsLast }, first: 20) {
        edges { node { id name { firstName lastName } phones { primaryPhoneNumber } } }
      }
    }
  `, { filter: { phones: { primaryPhoneNumber: { like: `%${last10}%` } } } });

  if (searchResult?.people?.edges?.length > 0) {
    const people = searchResult.people.edges.map(e => e.node);
    const best = people.find(p => {
      const fn = [p.name.firstName, p.name.lastName].filter(Boolean).join(' ');
      return fn && !fn.includes(cleanPhone) && fn.trim() !== 'WhatsApp' && fn.trim() !== '';
    }) || people[0];

    const fullName      = [best.name.firstName, best.name.lastName].filter(Boolean).join(' ');
    const isPlaceholder = !fullName || fullName.includes(cleanPhone) || fullName.trim() === 'WhatsApp';

    if (isPlaceholder && name && name.trim() && name !== cleanPhone) {
      const nameParts = name.trim().split(' ');
      await twentyQuery(`
        mutation UpdatePerson($id: UUID!, $data: PersonUpdateInput!) {
          updatePerson(id: $id, data: $data) { id }
        }
      `, { id: best.id, data: { name: { firstName: nameParts[0], lastName: nameParts.slice(1).join(' ') || cleanPhone } } });
      console.log(`[Twenty] Updated contact name: ${name}`);
    }

    const contact = { id: best.id, name: isPlaceholder ? (name || null) : fullName };
    await setTwentyCache(phone, contact);
    console.log(`[Twenty] Found contact: ${contact.name || cleanPhone}`);
    return contact;
  }

  const firstName = name ? name.trim().split(' ')[0] : 'WhatsApp';
  const lastName  = name ? (name.trim().split(' ').slice(1).join(' ') || cleanPhone) : cleanPhone;

  const createResult = await withRetry(() => twentyQuery(`
    mutation CreatePeople($data: [PersonCreateInput!]) {
      createPeople(data: $data) { id name { firstName lastName } }
    }
  `, { data: [{ name: { firstName, lastName }, phones: { primaryPhoneNumber: cleanPhone } }] }));

  if (createResult?.createPeople?.[0]) {
    const contact = { id: createResult.createPeople[0].id, name: name || null };
    await setTwentyCache(phone, contact);
    console.log(`[Twenty] Created contact: ${createResult.createPeople[0].id}`);
    return contact;
  }
  return null;
}

export async function getInquiryHistory(contactId) {
  const result = await twentyQuery(`
    query GetInquiries($filter: InquiryFilterInput) {
      inquiries(filter: $filter, orderBy: { createdAt: DescNullsLast }, first: 10) {
        edges {
          node {
            id referenceNumber tier status language
            origin destination commodity weightDims
            hazmat transportMode pickupAddress deliveryAddress
            createdAt
          }
        }
      }
    }
  `, { filter: { personId: { eq: contactId } } });
  return result?.inquiries?.edges?.map(e => e.node) || [];
}

export async function createTwentyInquiry(contactId, phone, tier, mem, fields) {
  if (!contactId) return null;
  const cleanPhone = phone.replace('whatsapp:', '');
  const tierValue  = tier === 1 ? 'AOG_EMERGENCY' : 'FREIGHT_INQUIRY';
  const transcript = mem.messages.map(m => `${m.role === 'user' ? 'Customer' : 'Patty'}: ${m.content}`).join('\n');
  const langMap    = { en: 'EN', es: 'ES', pt: 'PT' };
  const recordName = bestName(mem, fields, cleanPhone);

  const result = await withRetry(() => twentyQuery(`
    mutation CreateInquiry($data: InquiryCreateInput!) {
      createInquiry(data: $data) { id referenceNumber }
    }
  `, {
    data: {
      name:            recordName,
      referenceNumber: mem.refNumber,
      tier:            tierValue,
      status:          'CLOSED_BOT',
      language:        langMap[mem.language] || 'EN',
      escalated:       false,
      origin:          fields?.origin          || '',
      destination:     fields?.destination     || '',
      commodity:       fields?.commodity       || '',
      weightDims:      fields?.weightDims      || '',
      hazmat:          fields?.hazmat          || null,
      transportMode:   fields?.transportMode   || null,
      pickupAddress:   fields?.pickupAddress   || '',
      deliveryAddress: fields?.deliveryAddress || '',
      customerPhone:   cleanPhone,
      transcript:      transcript,
      personId:        contactId
    }
  }));

  if (result?.createInquiry) {
    console.log(`[Twenty] Created inquiry: ${result.createInquiry.id} (${mem.refNumber})`);
    return result.createInquiry.id;
  }
  return null;
}

export async function updateTwentyInquiry(inquiryId, updates) {
  if (!inquiryId) return;
  const result = await twentyQuery(`
    mutation UpdateInquiry($id: UUID!, $data: InquiryUpdateInput!) {
      updateInquiry(id: $id, data: $data) { id }
    }
  `, { id: inquiryId, data: updates });
  if (result?.updateInquiry) console.log(`[Twenty] Updated inquiry: ${inquiryId}`);
}
