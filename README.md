# Marginalia

A reading tracker, annotation tool, and knowledge platform — available as a Chrome extension and an Electron desktop app. Log what you read, highlight passages, take notes, share annotations with friends, and sync everything to GitHub and Telegram.

---

## Quick Start

### Chrome Extension

1. Clone this repo: `git clone https://github.com/jonathanwhen/marginalia.git`
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo folder.
3. Click the Marginalia icon on any page to start logging and highlighting.

### Electron App

1. `cd app && npm install`
2. `npm start` (or `npm run dev` for devtools)
3. To build a DMG: `npm run dist`

### Updating

```
git pull
```
Then reload the extension in `chrome://extensions` (click the reload arrow). For the Electron app, restart it.

---

## Features

### Reading Log (Popup)

Click the extension icon on any page to open the popup.

- **Auto-detection**: Title, author, and estimated page count are pulled from the page automatically.
- **Tags**: Choose from preset categories — `AI/ML Research`, `Healthcare/Bio`, `Philosophy`, `Economics/Finance`, `Research Craft`, `General Learning`, `To Revisit`. Multiple tags allowed.
- **Notes**: Freeform text field for key takeaways.
- **Starring**: Click the star icon to mark a reading as a favorite. Starred readings appear in Obsidian export frontmatter (`starred: true`) and are surfaced in the dashboard.
- **Conversation link**: Attach a Claude or ChatGPT conversation URL to any reading. The popup auto-detects when you're on a Claude/ChatGPT page and links it to the paper you were discussing. Stored as `conversationUrl` and exported in markdown frontmatter.
- **Unlog**: Remove a reading from your log via the popup if you logged it by mistake.
- **Auto-save**: If the form has data when the popup closes, it saves automatically.
- **Sync Now**: Button at the top triggers an immediate sync to all configured channels.

The popup header shows your daily page count against a 150-page goal.

### Highlighting

Works on both web pages and imported PDFs.

**On web pages:**
- Select any text → a floating toolbar appears with **Highlight** and **+ Comment** options.
- Or activate **Highlight mode** from the popup's Highlights tab — any text selection is immediately highlighted.
- Click an existing highlight to view, edit, or delete it.
- Right-click selected text → **Highlight with Marginalia** works on any page.

**In the PDF reader:**
- Four highlight colors available (orange, green, blue, pink) — pick from the toolbar.
- Same select-to-highlight flow, plus a dedicated highlight mode toggled with `H`.
- Export all highlights as Markdown via the export button.

### Sharing Annotations

Share your highlights and notes on any reading with anyone.

**Setup:**
1. Go to **Settings** → **Marginalia Account** → create an account (email + password).
2. Your Supabase project must have the schema from `supabase-schema.sql` applied (see [Supabase Setup](#supabase-setup)).

**Sharing:**
- Click **Share** in the popup (Highlights tab) or the library reader toolbar.
- A link is copied to your clipboard automatically.
- For web pages, the link opens the **original article** with your highlights overlaid in blue and an attribution banner showing your name.
- For library PDFs, the link opens a standalone viewer showing your highlights and notes.
- Re-sharing the same page updates the existing share (same link, fresh data).

**Managing shares:**
- Settings page shows all your shares with copy/delete buttons.

### Notes Sidebar

Open from the popup's **Note** tab → **Open Notes Sidebar**. A persistent sidebar slides in from the right on the current page.

- Auto-saves as you type (1-second debounce).
- `Cmd/Ctrl+S` for immediate save.
- Lists all highlights for the current page below the notes area.

### Dashboard

Open from the popup footer or navigate to the Dashboard page directly.

**Stats at a glance:**
- Total pages read, total readings, current day streak, and pages this week (with week-over-week trend).
- Activity heatmap showing the past 26 weeks of reading (GitHub contribution graph style).

**Readings table:**
- Sortable by title, author, tags, pages, highlights, or date.
- Search and tag filters in the toolbar.
- Click any row to expand a detail panel with notes, highlights, and a progress tracker. All fields are editable inline: title, author, tags, pages, URL, conversation URL, and notes.

**Reading progress:**
- In the detail panel, log how many pages you read on a given date.
- Progress bar shows logged pages vs. estimated total.
- Page entries appear as chips you can edit or delete.

### PDF Library

Open from the popup footer or the Library page directly.

**Importing:**
- Drag and drop PDF files, or use the **Select Files** / **Select Folder** buttons.
- Duplicates are automatically detected and skipped (content-hash dedup).
- Each PDF is auto-classified into a tag category based on filename and content keywords.
- A progress overlay shows import status for batch imports.

**Browsing:**
- Cards show title, page count, word count, highlight count, tags, and a content preview.
- Double-click a card's title or author to rename it inline.
- Search filters across title, author, tags, and body text.
- Sort by date, title, page count, or word count.

**Pinning:**
- Click the pin icon on any card to pin it to the top of the grid.
- Pinned items stay above unpinned items regardless of sort order, separated by a divider.

**Reading PDFs:**
- Click any card to open the built-in PDF reader with canvas rendering, text selection, lazy page loading, and scroll position memory.
- Full highlighting and notes support (same as web pages, plus color options and in-PDF search).
- Edit title and author from within the reader — click the pencil icon or press `E` to open the edit panel.

### Knowledge Graph

Visualizes connections between your readings using D3.js force-directed graph.

- Nodes: readings (colored by tag) + concepts (colored by type).
- Optional Claude API integration for automatic concept extraction from highlights and notes.
- Enable in Settings → Knowledge Graph → provide an Anthropic API key and toggle auto-extract.

### Sync

Configure in **Settings** (accessible from the popup footer or nav bar).

**GitHub:**
- Provide a Personal Access Token (fine-grained, Contents read/write), repo owner, repo name, and file path.
- Each sync pushes a full JSON snapshot of all readings (with highlights and notes) to the repo.
- Optional: per-reading `.md` files with YAML frontmatter (Obsidian-compatible) in a configurable directory. Files include reading log tables, highlights with inline LaTeX (`$...$`), and `[[wikilink]]` backlinks to related readings (shared tags).
- **Bulk Obsidian export**: Dashboard → Export button generates a `.zip` containing `readings/`, `tags/`, and `index.md` — drop the contents into an Obsidian vault. Both the bulk export and per-reading GitHub sync use a shared markdown module (`lib/markdown-export.js`) for identical output.
- **Restore from GitHub**: Pulls the JSON from the repo and merges missing readings into local storage.
- **Restore from File**: Same merge from a local `.json` backup.

**Telegram:**
- Provide a Bot Token and Chat ID.
- Each sync sends a diff message listing new and updated readings since the last sync.
- A daily summary is sent at 23:00 local time if you read anything that day.

**Auto-sync:**
- Configurable interval (default: 60 minutes, range: 1-1440).
- Runs automatically via a Chrome alarm. Only fires if at least one sync channel is configured.

### Auto-Classification

Readings are automatically tagged on creation using a keyword scoring system:

| Signal | Weight |
|---|---|
| Title keyword match | 3 pts |
| URL pattern match | 4 pts |
| Content keyword match | 1 pt |
| Title keyword in content | 0.5 pts |

A minimum score of 2.5 is required; otherwise the reading is tagged `General Learning`. Manual tag selections always take priority.

---

## Supabase Setup

The sharing feature uses Supabase (Postgres + auth) as a backend. To set it up:

1. Create a free project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor** → paste and run the contents of `supabase-schema.sql`.
3. (Recommended) Go to **Authentication** → **Providers** → **Email** → disable "Confirm email" for easier onboarding.
4. The project URL and anon key are already configured in `lib/supabase.js`.

---

## Keyboard Shortcuts

### Dashboard
| Key | Action |
|---|---|
| `/` | Focus search |
| `Escape` | Blur search, close detail panels |

### Library
| Key | Action |
|---|---|
| `/` | Focus search |
| `Escape` | Blur search |

### PDF Reader
| Key | Action |
|---|---|
| `H` | Toggle highlight mode |
| `E` | Toggle title/author edit panel |
| `Cmd/Ctrl+F` | Open in-document search |
| `Cmd/Ctrl+ +` or `=` | Zoom in |
| `Cmd/Ctrl+ -` | Zoom out |
| `Cmd/Ctrl+0` | Reset zoom (150%) |
| `Cmd/Ctrl+S` | Save notes |
| `Escape` | Close search / exit highlight mode / close edit panel / dismiss popovers |

### Web Pages
| Key | Action |
|---|---|
| `Escape` | Exit highlight mode / close sidebar |
| `Cmd/Ctrl+S` | Save note (in sidebar) |

---

## Data Storage

### Chrome Extension
| Data | Location |
|---|---|
| Reading metadata, highlights, scroll positions | `chrome.storage.local` |
| Sync credentials, Supabase session | `chrome.storage.local` / `chrome.storage.sync` |
| PDF files + extracted text | IndexedDB (`marginaliaDB`) |

### Electron App
| Data | Location |
|---|---|
| Reading metadata | `~/.marginalia/data.json` |
| PDF library | `~/.marginalia/library/` (meta.json + PDF binaries) |

### Cloud (Supabase)
| Data | Location |
|---|---|
| User accounts | `auth.users` (Supabase Auth) |
| Shared annotations | `shared_pages` table |

Web page keys use `origin + pathname`. Library PDF keys use a content hash: `library:{sha256prefix}-{size}-{filename}`.

---

## Project Structure

```
manifest.json          Chrome extension manifest (Manifest V3)
background.js          Service worker: sync, messaging, concept extraction
content.js / .css      Injected on all pages: highlighting, shared overlay
popup.html / .js       Extension popup: log readings, highlights, sharing
dashboard.html / .js   Stats dashboard: heatmap, readings table
library.html / .js     PDF library: import, browse, search
library-reader.html/js Canvas PDF viewer: highlighting, notes, sharing
graph.html / .js       D3 knowledge graph visualization
options.html / .js     Settings: credentials, account, share management
shared.html / .js      Viewer for shared library PDF annotations
nav-sync.js            Sync button wired into nav bar on all pages
lib/
  markdown-export.js   Shared Obsidian markdown builder (slugify, frontmatter, highlights)
  export.js            Bulk ZIP export (tag indexes, master index, packaging)
  supabase.js          Supabase client (auth + sharing, raw fetch)
  db.js                IndexedDB abstraction
  classify.js          Auto-classification keyword scoring
  collab.js            Real-time collaborative annotations
  readings-sync.js     Supabase readings sync (push/pull/merge)
  pdf-sync.js          Supabase PDF sync
  pdf.min.mjs          PDF.js library
  marked.min.js        Markdown parser
  katex.min.js         LaTeX math rendering
  dompurify.min.js     HTML sanitization
app/
  main.js              Electron main process
  preload.js           IPC bridge (chrome.* API polyfills)
  storage.js           File-based storage (~/.marginalia/)
  library-storage.js   File-based PDF storage
  sync.js              Sync logic (ported from background.js)
  package.json         Electron dependencies + build config
supabase-schema.sql    SQL schema for sharing tables + RLS policies
```
