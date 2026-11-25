// utils/supabase.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 주문 upsert (중복 방지)
async function upsertOrder(order) {
  const { data, error } = await supabase
    .from('orders')
    .upsert(order, {
      onConflict: 'channel_id,channel_order_no,channel_item_no',
      ignoreDuplicates: false
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// 채널 ID 조회
async function getChannelId(code) {
  const { data, error } = await supabase
    .from('channels')
    .select('id')
    .eq('code', code)
    .single();
  if (error) throw error;
  return data.id;
}

// 동기화 로그 기록
async function logSync(channelCode, result) {
  await supabase.from('sync_logs').insert({
    channel_code: channelCode,
    synced_count: result.synced || 0,
    error_count:  result.errors || 0,
    message:      result.message || '',
    synced_at:    new Date().toISOString()
  });
}

module.exports = { supabase, upsertOrder, getChannelId, logSync };
