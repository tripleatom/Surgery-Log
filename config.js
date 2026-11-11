// Fill in after creating your Supabase project (see README.md).
// Leave supabaseUrl empty to run in DEMO mode (sample data, nothing saved to a server).
window.SURGERY_LOG_CONFIG = {
  title: "Animal Surgery Log",
  labName: "Luan Lab",

  // Supabase → Project Settings → API
  supabaseUrl: "",       // e.g. "https://abcdefgh.supabase.co"
  supabaseAnonKey: "",   // the "anon public" key — safe to publish; row-level security protects the data

  photoBucket: "surgery-photos",
  // true = photos only visible to signed-in editors / photo viewers (private bucket; see schema.sql)
  privatePhotos: true,
};
