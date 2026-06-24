import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

const isPlaceholder = (value) =>
  !value || value.includes("your-supabase-project-id") || value.includes("your-supabase-anon-key");

let supabaseClient;

if (isPlaceholder(SUPABASE_URL) || isPlaceholder(SUPABASE_ANON_KEY)) {
  console.warn("Supabase URL or anon key is invalid or placeholder; realtime sharing is disabled.");
  supabaseClient = {
    channel: () => ({
      on: () => {},
      send: () => {},
      subscribe: async () => ({ error: null }),
    }),
  };
} else {
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
}

export const supabase = supabaseClient;
