/* NEXUS Construction Manager – server address. The publishable key is meant to be public:
   all data is protected by sign-in and the database rules, not by this key. */
window.NEXUS_CONFIG = {
  url: "https://wckospnwwdztilzgrnca.supabase.co",
  key: "sb_publishable_5AVzo_7Jol2pFwwlKAgUdA_usrUTqzi",
  edition: 'standalone', cloud: true,   // NEXUS Cloud: many companies in one system
  firebase: null   // phone notifications: add this customer's own Firebase IDs later (optional)
};
