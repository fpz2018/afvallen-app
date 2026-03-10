import { createClient, SupabaseClient } from '@supabase/supabase-js'

export function getSupabase(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
}
