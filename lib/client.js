// This client's build: name, branding and wording. Lives in /client so each client's repo carries its own.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'client');
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

const logoFile = ['logo.svg', 'logo.png', 'logo.jpg'].map(f => path.join(dir, f)).find(f => fs.existsSync(f)) || null;
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
config.logo = logoFile ? { file: logoFile, type: LOGO_TYPES[path.extname(logoFile)] } : null;

module.exports = config;
