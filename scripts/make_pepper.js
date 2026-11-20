#!/usr/bin/env node
// Prints a new random value for the PASSWORD_PEPPER script property (refactor Phase 2.5, step A).
//   node scripts/make_pepper.js        (or: npm run make:pepper)
// It only prints: nothing is saved, sent or written to the repo. Copy the value into
// Apps Script > Project Settings > Script Properties > PASSWORD_PEPPER, and keep a copy in a safe place.
// Set it ONCE. Changing or deleting it later locks out every staff account that has already been upgraded.
const crypto = require("crypto");

function makePepper(bytes) {
  return crypto.randomBytes(bytes || 36).toString("base64url");   // 36 bytes = 48 characters, letters, digits, - and _
}

if (require.main === module) {
  const value = makePepper();
  console.log("");
  console.log("PASSWORD_PEPPER value (" + value.length + " characters):");
  console.log("");
  console.log("  " + value);
  console.log("");
  console.log("1. Apps Script editor > Project Settings (gear) > Script Properties > Add script property.");
  console.log("2. Property: PASSWORD_PEPPER   Value: the line above. Save.");
  console.log("3. Keep a copy somewhere safe (a password manager). Never put it in the repo or a chat.");
  console.log("4. Set it once and never change it: upgraded staff could not sign in with a different value.");
  console.log("");
}

module.exports = { makePepper };
