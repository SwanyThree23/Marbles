// Learn content, carried over from the original preview.
export const GLOSSARY = [
  { ic: '🌀', nm: 'Swirl', d: 'Handmade marbles with colored glass ribbons twisted through a clear or colored base — the most collected vintage style.' },
  { ic: '💠', nm: 'Sulphide', d: 'Clear glass marbles with a figurine (animal, person, or object) sealed inside — prized for rarity and craftsmanship.' },
  { ic: '🐱', nm: "Cat's Eye", d: 'Machine-made marbles with a vane of color shaped like an eye, injected into a clear glass base — a schoolyard classic.' },
  { ic: '⚪', nm: 'Aggie', d: 'Originally carved from agate stone; now refers to any hard, durable shooter marble used in games.' },
  { ic: '🌊', nm: 'Oxblood', d: 'A rich, dark red swirl style made by Christensen Agate Co. in the 1920s-30s — one of the most sought-after colors.' },
  { ic: '👑', nm: 'Lutz', d: 'Marbles with copper-flecked glass bands that shimmer gold — named after German glassmaker Nicholas Lutz.' },
  { ic: '🌪️', nm: 'Corkscrew', d: 'Two or more colored ribbons twisted in a spiral down the length of the marble, like a barber pole.' },
  { ic: '🫧', nm: 'Clambroth', d: 'Opaque marbles, usually white or colored base, with thin evenly-spaced colored lines circling the surface.' },
];

export const QUIZ = [
  { q: "What gives a Cat's Eye marble its name?", opts: ['The vane of color shaped like an eye', "It's made from real feline glass", 'It has two dots painted on', 'It glows in the dark'], a: 0 },
  { q: 'Which era are true handmade German swirl marbles generally from?', opts: ['1990s–2000s', '1840s–1920s', '2010s', '1960s only'], a: 1 },
  { q: "What's inside a Sulphide marble?", opts: ['Air bubbles only', 'A sealed figurine', 'Liquid glass', "Nothing, it's solid color"], a: 1 },
  { q: 'What material were the very first marbles typically made from, before glass?', opts: ['Plastic', 'Fired clay or stone', 'Rubber', 'Wood'], a: 1 },
  { q: "In marble slang, what is a 'shooter'?", opts: ['A tiny peewee marble', 'The larger marble used to shoot with', 'A cracked marble', 'A trade-only marble'], a: 1 },
  { q: "What does an Oxblood swirl's color usually resemble?", opts: ['Bright yellow', 'Deep, dark red', 'Pale green', 'Sky blue'], a: 1 },
  { q: "What's a Corkscrew marble named for?", opts: ['Its spiral color pattern', 'Its shape, like a bottle opener', 'Where it was found', "Its inventor's last name"], a: 0 },
];

export const CATEGORIES = ['Swirl', 'Sulphide', "Cat's Eye", 'Aggie', 'Vintage'];
export const MARBLE_ICONS = ['🔮', '💠', '🌀', '🟣', '🟠', '🔵', '⚪', '🟢'];
export const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
// "42", "42.5", "$42.50" -> 4250; anything else (e.g. "abc", "-3") -> null
export function parsePriceToCents(text) {
  const t = String(text ?? '').trim().replace(/^\$/, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}
