const fs = require('fs');
const path = require('path');

const envPath = path.join('C:\\Users\\lukes\\cortextos\\orgs\\sitesmith-agency\\agents\\smith\\.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const tokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
const token = tokenMatch[1].trim();

async function diagnose() {
  const resp1 = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=-5197520132`);
  const data1 = await resp1.json();
  console.log('GROUP CHAT:', JSON.stringify(data1, null, 2));

  const resp2 = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: -5197520132, text: 'direct api group test' })
  });
  const data2 = await resp2.json();
  console.log('SEND RESULT:', JSON.stringify(data2, null, 2));
}

diagnose();
