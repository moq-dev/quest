# Quest log theme

Quest presents itself as an original quest log for your repository and your
agents. This page is the source of truth for that presentation: the display
glossary, status markers, size colours, palette, type, and mark. The
site, board, CLI, and copy keep small tables that cite it.

The theme is presentation only. Quest files, `quest check`, `quest guide`, and
the skills keep the format's own terms. Its files live in `design/theme/`, not
`docs/`, which the site publishes as user documentation, or `assets/`, which
holds the agent contract embedded in the binary.

## Rules

- Modern game UI, not fantasy pastiche. Use only genre conventions: `!` and
  `?` markers, a quest log, and rarity-coloured sizes. No serif blackletter,
  parchment, gold leaf, ornaments, or skeuomorphic trim, and no names, art,
  fonts, icons, or screenshots from any game.
- Hand-written SVG and CSS, and open-licensed fonts only.
- Dark only. There is no light mode.
- Never use colour as the only signal. Every marker and size colour comes with
  its text label.
- No XP, levels, achievements, or leaderboards.

## Voice

Hook, then substance. Lead with "a quest log for your repo and your agents",
then deliver the pitch: readable plans, explicit dependencies, and reviewable
Git changes.

Plain copy with a light game flavour. "Quest" and "quest log" are the product,
so they stay, along with the markers and size colours. Everything else reads
like a modern developer tool: no party, no gold, no roman numerals, no pixel
art or sound. Agent tokens are called tokens.

## Glossary

Use display names in prose and interfaces. Anything a reader must type or
match, such as quest headings, CLI commands, and `--help` text, keeps the
format term. The CLI's terminal output keeps the format terms too (ready,
blocked and `Required:`), with the markers and size colours.

| Format term | Display | Marker |
| --- | --- | --- |
| ready | Available | amber `!` |
| ready, while GitHub reconciliation is incomplete | Availability pending | |
| blocked | Requires: *titles* | grey `!` |
| live runner lock | Accepted by @*name* | |
| open PR or change | Ready to turn in | amber `?` |
| merged | Quest complete | |
| `Goal` | Objectives | |
| `Closes` | Rewards | |
| agent tokens, donated or spent | tokens | token chip |
| fund a quest | Offer tokens | token chip |

A quest shows its most advanced state: Ready to turn in, then Accepted by, then
Available or Requires. Accepted by comes from a live runner lock: an active
job in kix.quest's database, which moves when its runner goes offline; open changes
carry Ready to turn in. On GitHub, a draft PR from the quest branch, opened
right away and from a fork too, claims work: the board shows it as Claimed
by its starter until its body hands it back with a `## Waiting` (or older
`## Decisions needed`) section or it is marked ready, and only then as Ready to turn in.
None of these states adds a section to the quest file.

Tokens are display only: a run's spend and donated tokens show with an amber
token chip. There is no pledge pool and no new state.

## Size

Quests are coloured by size on every surface (the site, the board, the map,
and the CLI) along the loot-rarity ladder players already know: grey, green,
blue, purple, orange. Show the size label next to its colour.

| Size | Colour | Hex | Terminal SGR |
| --- | --- | --- | --- |
| XS | grey | `#9ba5b4` | `90` |
| S | green | `#4ade80` | `32` |
| M | blue | `#4da3ff` | `34` |
| L | purple | `#b98cff` | `35` |
| XL | orange | `#ff9a3c` | `33` |

XL has no extra tag: its orange and its size label already stand out.

Contrast as text on the three surfaces (WCAG AA needs 4.5:1):

| Size | `--ql-bg` | `--ql-panel` | `--ql-raised` |
| --- | --- | --- | --- |
| XS | 7.9:1 | 7.3:1 | 6.6:1 |
| S | 11.2:1 | 10.5:1 | 9.4:1 |
| M | 7.5:1 | 7.0:1 | 6.2:1 |
| L | 7.7:1 | 7.2:1 | 6.4:1 |
| XL | 9.3:1 | 8.7:1 | 7.7:1 |

The `.ql-size` badge tints its background with 14% of the hue, which lowers
these ratios slightly; every size still passes on every surface.

Markers use the accent: amber (`#ffc53d`, SGR `33`) for `!` ready and `?` in
review, and grey (`#9ba5b4`, SGR `90`) for a blocked `!`.
Terminal colours are named ANSI SGR codes, so they follow the user's terminal
palette and work on any colour terminal. The 16-colour palette has no orange,
so XL uses yellow `33`, which many palettes render orange-brown.

## Palette

A modern game menu: cool near-black surfaces, hairline borders, crisp white
text, one amber accent, and rarity hues for sizes.
[`theme/theme.css`](theme/theme.css) defines these as `--ql-*` custom
properties.

| Token | Hex | Use |
| --- | --- | --- |
| `--ql-bg` | `#0a0c11` | page backdrop |
| `--ql-panel` | `#11151d` | panels |
| `--ql-raised` | `#1a202b` | buttons, insets, inline code |
| `--ql-rule` | `#262e3b` | hairline borders, dividers |
| `--ql-rule-strong` | `#3a4557` | hover borders, unsized entry edges |
| `--ql-accent` | `#ffc53d` | primary buttons, markers, eyebrows, focus, tokens |
| `--ql-accent-dim` | `#8a6a1f` | the start of the progress fill |
| `--ql-text` | `#e8ecf3` | body text and headings |
| `--ql-muted` | `#97a2b4` | secondary text |
| `--ql-link` | `#7cc4ff` | links |
| `--ql-grey` | `#9ba5b4` | XS, blocked marker |
| `--ql-green` | `#4ade80` | S |
| `--ql-blue` | `#4da3ff` | M |
| `--ql-purple` | `#b98cff` | L |
| `--ql-orange` | `#ff9a3c` | XL |

Components colour sizes through `--ql-size-xs`, `--ql-size-s`, `--ql-size-m`,
`--ql-size-l`, and `--ql-size-xl` (or the `.ql-xs` to `.ql-xl` classes), which
point at the hues above, so a scale change is a token change.

Every text colour meets WCAG AA (4.5:1) on `--ql-bg`, `--ql-panel`, and
`--ql-raised`. The lowest is blue on `--ql-raised`, at 6.2:1. Dark text on the
amber accent is 12.4:1.

## Type

- Display: [Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed),
  weights 600 and 700. Page and section headings, buttons, navigation, and
  labels are uppercase with wide tracking; smaller headings stay mixed case.
- Body: [Inter](https://fonts.google.com/specimen/Inter), weights 400 and 600.
- Code: the system monospace font.

Both fonts use the SIL Open Font License 1.1. Load them from Google Fonts;
do not commit font files. `theme.css` has the fallback stacks.

## Components

[`theme/theme.css`](theme/theme.css) also carries the shared pieces:

- Panel (`.ql-panel`): a raised surface with a hairline border, a faint top
  sheen, and a short accent tab on its top edge. `--ql-tab` recolours the tab.
  Quests, docs, and code samples sit on panels.
- Eyebrow (`.ql-eyebrow`): a small uppercase label in the accent above a
  heading. It replaces ornamental dividers between sections.
- Markers, size colours (`.ql-size`), and token amounts (`.ql-tokens`), each
  with its text label.

The site adds clipped-corner buttons, log entries edged in their size colour
like inventory slots, a glowing progress bar, and a faint grid behind the top
of each page.

## Mark

[`theme/logo.svg`](theme/logo.svg) is a flat dark `!` on an amber rounded
square. It carries its own fill, so it reads on light and dark pages, and it
stays legible at 16 px for favicons. Use it as is: do not recolour it, add
text inside it, or pair it with game art.

[`theme/icon.svg`](theme/icon.svg) is the installed app's icon: the same `!`
on a full-bleed amber square, since home screens round or mask icons
themselves, with the `!` inside the maskable safe zone. `icon-192.png` and
`icon-512.png` are its exports:

```sh
for size in 192 512; do
  google-chrome --headless=new --hide-scrollbars --window-size=$size,$size \
    --screenshot=design/theme/icon-$size.png "file://$PWD/design/theme/icon.svg"
done
```

## Social image

[`theme/og.svg`](theme/og.svg) is the source and
[`theme/og.png`](theme/og.png) the 1280 by 640 export. The SVG imports
Barlow Condensed and Inter from Google Fonts, so export it with network
access. Headless Chrome can silently fall back to system fonts on a cold font
cache, so re-run the export if the fonts look wrong:

```sh
google-chrome --headless=new --hide-scrollbars --virtual-time-budget=10000 \
  --window-size=1280,640 --screenshot=design/theme/og.png \
  "file://$PWD/design/theme/og.svg"
```

A maintainer uploads `og.png` by hand under the repository's Settings, General,
Social preview.
