const YCLOUD_COOKIE = 'remember-me=anVhbm1hdGlhczE5OTYlNDBnbWFpbC5jb206MTc4NDY2Njk3NjQ5ODpjMDY5MWE5NzUyMmI1NzM5ZTgxNjRhZTA2NTZmZDU3Mg';
const JUAN_AGENT_ID = '6a32db30e0e65a1bac12a7a2';
const SUPABASE_URL = 'https://qukgtlwessujumdmfgnm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1a2d0bHdlc3N1anVtZG1mZ25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM3MjY1MCwiZXhwIjoyMDg3OTQ4NjUwfQ.iWPH9PEGNixiZUPl8f-pJLv7dl6wBeOEw9psOnlrMq4';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000');

async function getAllConversations() {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ pageNum: 1, pageSize: 100 }),
  });
  if (!resp.ok) throw new Error(`ycloud list failed: ${resp.status}`);
  const data = await resp.json();
  return data?.data?.conversation || [];
}

function extractCustomerPhone(conv) {
  if (conv.contact?.phoneNumber) return conv.contact.phoneNumber.replace(/\D/g, '');
  for (const msg of conv.messages || []) {
    if (msg.messageDirection === 0 && msg.from) return msg.from.replace(/\D/g, '');
    if (msg.messageDirection === 1 && msg.to)  return msg.to.replace(/\D/g, '');
  }
  return null;
}

async function ycloudTransfer(convId, agentId, unassigned) {
  const resp = await fetch('https://www.ycloud.com/api/inbox/conversation/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: YCLOUD_COOKIE },
    body: JSON.stringify({ agentId, conversationId: convId, teamId: '', unassigned }),
  });
  if (!resp.ok) throw new Error(`ycloud transfer failed: ${resp.status}`);
}

async function getAllSupabaseRows() {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?select=telefono,estado_conversacion`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!resp.ok) throw new Error(`supabase GET all failed: ${resp.status}`);
  return await resp.json();
}

// PATCH only – for rows that already exist in Supabase
async function supabasePatch(phoneDigits, estado) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram?telefono=ilike.*${phoneDigits}*`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ estado_conversacion: estado }),
    }
  );
  if (!resp.ok) throw new Error(`supabase PATCH failed: ${resp.status}`);
}

// INSERT only – for phones with no existing Supabase row
async function supabaseInsert(fullPhone, estado) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/memoria_ram`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ telefono: fullPhone, estado_conversacion: estado, historial: '[]' }),
    }
  );
  // 409 = conflict (unique violation) → row was created by bot between our read and write → ok
  if (!resp.ok && resp.status !== 409) throw new Error(`supabase INSERT failed: ${resp.status}`);
}

async function poll() {
  const convs = await getAllConversations();
  const juanConvs = convs.filter(c => c.assigneeId === JUAN_AGENT_ID);

  // Single GET for all Supabase rows → build map digits→estado
  const allRows = await getAllSupabaseRows();
  const supaMap = {};
  for (const row of allRows) {
    const digits = row.telefono.replace(/\D/g, '').slice(-10);
    supaMap[digits] = row.estado_conversacion || '';
  }

  // Direction A: Juan assigned in ycloud → set PAUSADO if not already
  for (const conv of juanConvs) {
    const phone = extractCustomerPhone(conv);
    if (!phone) continue;
    const digits = phone.slice(-10);
    const estado = supaMap[digits] !== undefined ? supaMap[digits] : null;

    if (estado !== null && estado.startsWith('PAUSADO')) continue; // already PAUSADO → skip

    const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const newEstado = `PAUSADO:${expiry}`;

    if (estado === null) {
      // No row in Supabase at all → INSERT
      await supabaseInsert(phone, newEstado);
    } else {
      // Row exists but not PAUSADO → PATCH (preserves historial etc.)
      await supabasePatch(digits, newEstado);
    }
    supaMap[digits] = newEstado; // update local map so Direction D sees it
    console.log(`[${new Date().toISOString()}] PAUSADO (Juan asignado) → ${phone}`);
  }

  // Direction B: Supabase DERIVADO → assign Juan in ycloud + set PAUSADO
  for (const row of allRows.filter(r => r.estado_conversacion?.startsWith('DERIVADO'))) {
    const phone = row.telefono.replace(/\D/g, '');
    const conv = convs.find(c => {
      const p = extractCustomerPhone(c);
      return p && p.endsWith(phone.slice(-10));
    });
    if (!conv) continue;
    if (conv.assigneeId === JUAN_AGENT_ID) continue;

    await ycloudTransfer(conv.id, JUAN_AGENT_ID, false);
    const expiry = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await supabasePatch(phone.slice(-10), `PAUSADO:${expiry}`);
    console.log(`[${new Date().toISOString()}] ASIGNADO + PAUSADO → ${phone} (conv: ${conv.id})`);
  }

  // Direction D: Supabase PAUSADO + Juan NO asignado en ycloud → liberar bot
  for (const row of allRows.filter(r => r.estado_conversacion?.startsWith('PAUSADO'))) {
    const phone = row.telefono.replace(/\D/g, '');
    const conv = convs.find(c => {
      const p = extractCustomerPhone(c);
      return p && p.endsWith(phone.slice(-10));
    });
    if (!conv) continue; // sin conv activa en ycloud → no tocar
    if (conv.assigneeId === JUAN_AGENT_ID) continue; // Juan sigue asignado → mantener pausado

    // Conv existe pero Juan ya no está asignado → liberar bot
    await supabasePatch(phone.slice(-10), '');
    console.log(`[${new Date().toISOString()}] LIBERADO (Juan desasignado) → ${phone}`);
  }
}

async function run() {
  console.log(`NecoBot Sync arrancado. Intervalo: ${POLL_INTERVAL_MS / 1000}s`);
  while (true) {
    try { await poll(); }
    catch (err) { console.error(`[${new Date().toISOString()}] ERROR:`, err.message); }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

require('http').createServer((_, res) => res.end('ok')).listen(3000);
run();
