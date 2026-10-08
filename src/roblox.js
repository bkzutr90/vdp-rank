// Helper API publik Roblox (tanpa API key)

async function lookupUser(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!res.ok) throw new Error(`Roblox API error ${res.status}`);
  const data = await res.json();
  const u = data.data && data.data[0];
  return u ? { id: String(u.id), name: u.name } : null;
}

async function getDescription(robloxId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${robloxId}`);
  if (!res.ok) throw new Error(`Roblox API error ${res.status}`);
  const data = await res.json();
  return data.description || '';
}

const profileUrl = (robloxId) => `https://www.roblox.com/users/${robloxId}/profile`;

module.exports = { lookupUser, getDescription, profileUrl };
