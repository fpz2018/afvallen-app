import { createClient, SupabaseClient } from '@supabase/supabase-js'

const clientCache = new Map<string, SupabaseClient>()

export function getSupabase(env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }): SupabaseClient {
  const cacheKey = env.SUPABASE_URL + env.SUPABASE_SERVICE_ROLE_KEY
  if (!clientCache.has(cacheKey)) {
    clientCache.set(cacheKey, createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY))
  }
  return clientCache.get(cacheKey)!
}
