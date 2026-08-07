// The emoji the picker offers, and how a typed query finds them.

// A picked shortlist rather than the whole of Unicode: what a note or a comment
// actually reaches for. A full set is an index, a font problem and a download,
// which is a different feature from "put a 👍 in this sentence".
//
// Grouped the way a keyboard groups them so the one you want is where you
// expect, and ordered by how often it gets used here rather than by codepoint.
//
// Every entry carries its own search terms as one space-separated string -
// readable in the table, and split once at module load into what the search
// actually matches against. Alongside the names are the typed emoticons they
// stand in for (`<3`, `:)`, `+1`), because that is what a lot of people reach
// for first and the picker should meet them there rather than making them
// translate it into a word.
export interface Emoji { ch: string; keys: string[]; }
export interface EmojiGroup { name: string; items: Emoji[]; }

function emojiGroup(name: string, table: [string, string][]): EmojiGroup {
  return { name, items: table.map(([ch, keys]) => ({ ch, keys: keys.split(' ') })) };
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  emojiGroup('Smileys', [
    ['😀', 'grin smile smiling happy :d'],
    ['😃', 'smiley happy open grin :d'],
    ['😄', 'laugh happy grinning smile :d'],
    ['😁', 'beam grin teeth pleased'],
    ['😅', 'sweat nervous relief laugh phew'],
    ['😂', 'joy tears laugh crying lol lmao xd'],
    ['🙂', 'slight smile happy :) :-)'],
    ['🙃', 'upside down silly irony sarcasm'],
    ['😉', 'wink joke ;) ;-)'],
    ['😊', 'blush smile happy warm pleased ^^'],
    ['😍', 'heart eyes love adore crush <3'],
    ['😘', 'kiss blowing love :* xx'],
    ['😋', 'yum tongue tasty delicious :p :-p'],
    ['😎', 'cool sunglasses shades smug b-)'],
    ['🤩', 'star struck excited amazed wow'],
    ['🤔', 'think thinking hmm consider ponder'],
    ['🤨', 'raised eyebrow skeptical sceptical doubt suspicious'],
    ['😐', 'neutral flat meh blank :|'],
    ['🙄', 'roll eyes eyeroll annoyed exasperated'],
    ['😬', 'grimace awkward cringe eek yikes'],
    ['😴', 'sleep sleeping tired bored zzz'],
    ['😢', 'cry sad tear upset :( :-('],
    ['😭', 'sob crying bawl loud devastated :\'('],
    ['😤', 'huff triumph frustrated steam determined'],
    ['😱', 'scream shock fear horror panic'],
    ['🤯', 'mind blown exploding head shocked wow'],
    ['😳', 'flushed embarrassed surprised blush'],
    ['🥳', 'party partying celebrate birthday hooray'],
    ['😇', 'innocent angel halo saint o:)'],
    ['🤗', 'hug hugging thanks welcome'],
    ['🤐', 'zipper mouth secret quiet silence shh'],
    ['🤒', 'sick ill thermometer fever unwell'],
  ]),
  emojiGroup('Gestures', [
    ['👍', 'thumbs up like yes approve good +1'],
    ['👎', 'thumbs down dislike no bad reject -1'],
    ['👌', 'ok okay perfect fine nice'],
    ['🤝', 'handshake deal agree partner shake'],
    ['👏', 'clap applause bravo praise well done'],
    ['🙌', 'raised hands celebrate praise hooray yay'],
    ['🙏', 'pray thanks please thank you namaste'],
    ['💪', 'muscle strong flex power arm'],
    ['✌️', 'victory peace two fingers'],
    ['🤞', 'fingers crossed luck lucky hope'],
    ['👋', 'wave hello hi bye goodbye greeting'],
    ['🫡', 'salute respect acknowledged yes sir'],
    ['🤷', 'shrug dunno whatever idk unsure'],
    ['🤦', 'facepalm despair oops smh'],
    ['👀', 'eyes look watch see looking'],
    ['🧠', 'brain smart mind think intelligence'],
  ]),
  emojiGroup('Hearts & sparks', [
    ['❤️', 'heart love red like <3'],
    ['🧡', 'orange heart love <3'],
    ['💛', 'yellow heart love friendship <3'],
    ['💚', 'green heart love <3'],
    ['💙', 'blue heart love <3'],
    ['💜', 'purple heart love <3'],
    ['🖤', 'black heart love dark <3'],
    ['🤍', 'white heart love <3'],
    ['💔', 'broken heart break breakup sad </3'],
    ['💯', 'hundred 100 perfect score full agree'],
    ['✨', 'sparkles shine magic new shiny clean'],
    ['⭐', 'star favourite favorite rating starred'],
    ['🌟', 'glowing star shine sparkle bright'],
    ['🔥', 'fire hot lit flame burn great'],
    ['💥', 'boom explosion bang collision impact'],
    ['⚡', 'zap lightning bolt fast power energy'],
  ]),
  emojiGroup('Reading & work', [
    ['📚', 'books library reading stack study'],
    ['📖', 'book open reading read page'],
    ['📝', 'memo note write notes writing draft'],
    ['✏️', 'pencil write edit draft'],
    ['📌', 'pin pinned important stick'],
    ['📎', 'paperclip attach attachment clip'],
    ['🔖', 'bookmark save tag label saved'],
    ['🗂️', 'dividers files folders organise organize tabs'],
    ['💡', 'idea bulb light tip insight lightbulb'],
    ['🔍', 'search magnify find look zoom lens'],
    ['🔗', 'link url chain href hyperlink'],
    ['💻', 'laptop computer code work dev coding'],
    ['📱', 'phone mobile device smartphone'],
    ['🖥️', 'desktop monitor screen computer display'],
    ['📷', 'camera photo picture snap shot'],
    ['🎧', 'headphones audio listen music podcast'],
    ['🎵', 'music note song tune audio'],
    ['⏰', 'alarm clock time reminder wake deadline'],
    ['🗓️', 'calendar date schedule planner month'],
    ['📈', 'chart up growth increase trend rising'],
    ['📉', 'chart down decrease decline loss falling'],
    ['📊', 'bar chart stats data graph analytics'],
    ['🧾', 'receipt invoice bill record expense'],
    ['🗃️', 'card box archive files index storage'],
  ]),
  emojiGroup('Nature', [
    ['🌱', 'seedling sprout grow new plant growth'],
    ['🌿', 'herb leaf plant green foliage'],
    ['🍀', 'clover luck lucky four leaf shamrock'],
    ['🌳', 'tree forest nature wood park'],
    ['🌸', 'blossom flower spring cherry sakura'],
    ['🌻', 'sunflower flower summer bloom'],
    ['🌎', 'earth globe world planet america'],
    ['🌙', 'moon night crescent evening'],
    ['☀️', 'sun sunny day bright weather summer'],
    ['☁️', 'cloud cloudy weather overcast grey gray'],
    ['🌧️', 'rain rainy weather shower wet'],
    ['❄️', 'snowflake snow cold winter freeze frozen'],
    ['🐈', 'cat kitten pet meow feline'],
    ['🐕', 'dog puppy pet woof hound'],
    ['🦊', 'fox animal wildlife'],
    ['🐢', 'turtle tortoise slow animal shell'],
  ]),
  emojiGroup('Food & drink', [
    ['☕', 'coffee cup espresso morning caffeine brew'],
    ['🍵', 'tea green matcha cup brew'],
    ['🍺', 'beer pint pub drink cheers ale'],
    ['🍷', 'wine glass drink red vino'],
    ['🥂', 'cheers toast celebrate champagne clink'],
    ['🍕', 'pizza slice food italian'],
    ['🍔', 'burger hamburger food beef'],
    ['🌮', 'taco food mexican'],
    ['🍎', 'apple fruit food healthy red'],
    ['🍩', 'donut doughnut sweet snack'],
    ['🍪', 'cookie biscuit sweet snack'],
    ['🎂', 'cake birthday celebrate dessert'],
  ]),
  emojiGroup('Going places', [
    ['✈️', 'plane flight travel fly airplane trip'],
    ['🚀', 'rocket launch ship fast space shipped'],
    ['🚗', 'car drive auto vehicle road'],
    ['🚲', 'bike bicycle cycle ride cycling'],
    ['🏔️', 'mountain peak hike snow alps summit'],
    ['🏖️', 'beach holiday vacation sand sea'],
    ['🎉', 'party tada celebrate hooray congrats launch'],
    ['🎁', 'gift present birthday wrapped'],
    ['🏆', 'trophy win award champion prize'],
    ['🎯', 'target bullseye goal aim dart focus'],
    ['⚽', 'football soccer ball sport'],
    ['🎮', 'game gaming controller play console'],
  ]),
  emojiGroup('Symbols', [
    ['✅', 'check tick done yes complete finished'],
    ['❌', 'cross no wrong fail x incorrect'],
    ['⚠️', 'warning caution alert careful danger'],
    ['❓', 'question help ask query ?'],
    ['❗', 'exclamation important alert attention !'],
    ['🚫', 'prohibited no forbidden ban blocked stop'],
    ['🔒', 'lock locked secure private closed'],
    ['🔓', 'unlock unlocked open public'],
    ['➡️', 'right arrow next forward then'],
    ['⬅️', 'left arrow back previous'],
    ['⬆️', 'up arrow top increase above'],
    ['⬇️', 'down arrow bottom decrease below'],
    ['🔁', 'repeat loop cycle refresh again'],
    ['➕', 'plus add new more +'],
    ['➖', 'minus remove subtract less -'],
    ['™️', 'trademark tm brand'],
  ]),
];

/**
 * Does this emoji answer the query? Every whitespace-separated part of the
 * query has to match the start of one of the entry's terms, so "open bo" finds
 * the open book and a two-word query narrows rather than widens.
 *
 * Prefix matching rather than substring: "art" should not turn up every heart
 * in the set. Punctuation is matched literally, which is the whole point of
 * carrying `<3` and `:)` as terms - they only work if the query isn't
 * word-split or stripped on its way in.
 */
export function emojiMatches(e: Emoji, parts: string[]): boolean {
  return parts.every(p => e.keys.some(k => k.startsWith(p)));
}

/**
 * The picker's whole search. Returns null - not an empty list - for a blank
 * query: no query is not "nothing matched", it is the grouped set the picker
 * opens on, and only the caller can tell those apart.
 *
 * Results keep the order of the table, so the groups' rough
 * most-used-first ordering carries through into the flat result list and
 * Enter-on-the-first-hit lands somewhere sensible.
 */
export function searchEmoji(query: string): Emoji[] | null {
  const parts = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return EMOJI_GROUPS.flatMap(g => g.items.filter(e => emojiMatches(e, parts)));
}
