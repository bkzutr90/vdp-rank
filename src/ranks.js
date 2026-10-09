const TIERS = [
  { name: 'Rookie',        emoji: '⚔', color: '#CD7F32', min: 0,    max: 999 },
  { name: 'Bloodhound',    emoji: '◎', color: '#C0C7D1', min: 1000, max: 1199 },
  { name: 'Executioner',   emoji: '⚔', color: '#FFD24A', min: 1200, max: 1399 },
  { name: 'Phantom',       emoji: '◈', color: '#4FD6C8', min: 1400, max: 1599 },
  { name: 'Reaper',        emoji: '☠', color: '#4AA8FF', min: 1600, max: 1799 },
  { name: 'Overlord',      emoji: '♛', color: '#B36BFF', min: 1800, max: 1999 },
  { name: 'Apex Predator', emoji: '✦', color: '#FF4D4D', min: 2000, max: Infinity },
];

const DIVISIONS = ['I', 'II', 'III']; // I = bawah, III = atas tier

function getRank(mmr) {
  const tier = [...TIERS].reverse().find((t) => mmr >= t.min) || TIERS[0];
  let division = '';
  if (tier.max !== Infinity) {
    const size = (tier.max - tier.min + 1) / 3;
    const idx = Math.min(2, Math.floor((mmr - tier.min) / size));
    division = DIVISIONS[idx];
  }
  return {
    tier,
    division,
    label: `${tier.emoji} ${tier.name}${division ? ' ' + division : ''}`,
  };
}

// Probabilitas menang A melawan B (Elo)
function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

module.exports = { TIERS, getRank, expected };
