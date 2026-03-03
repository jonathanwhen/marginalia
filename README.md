# Marginalia

A Chrome extension for tracking, annotating, and organizing your reading across the web and imported PDFs. Log what you read, highlight passages, take notes, and sync everything to Telegram and GitHub.

---

## Quick Start

1. Load the extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked → select this folder).
2. Navigate to any article or page and click the Marginalia icon in the toolbar.
3. The popup auto-fills the title, author, and estimated page count. Add tags if you want, then click **Log Reading**.
4. To highlight text, switch to the **Highlights** tab in the popup and click **Start Highlighting**, or right-click selected text → **Highlight with Marginalia**.

---

## Features

### Reading Log (Popup)

Click the extension icon on any page to open the popup.

- **Auto-detection**: Title, author, and estimated page count are pulled from the page automatically.
- **Tags**: Choose from preset categories — `AI/ML Research`, `Healthcare/Bio`, `Philosophy`, `Economics/Finance`, `Research Craft`, `General Learning`, `To Revisit`. Multiple tags allowed.
- **Notes**: Freeform text field for key takeaways.
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
- Click any row to expand a detail panel with notes, highlights, and a progress tracker.

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
- Search filters across title, author, tags, and body text.
- Sort by date, title, page count, or word count.

**Pinning:**
- Click the pin icon (📌) on any card to pin it to the top of the grid.
- Pinned items stay above unpinned items regardless of sort order, separated by a divider.
- Each group sorts independently by the active sort key.
- Pin state persists across sessions.

**Reading PDFs:**
- Click any card to open the built-in PDF reader with canvas rendering, text selection, lazy page loading, and scroll position memory.
- Full highlighting and notes support (same as web pages, plus color options and in-PDF search).

### Sync

Configure in **Settings** (accessible from the popup footer).

**Telegram:**
- Provide a Bot Token and Chat ID.
- Each sync sends a diff message listing new and updated readings since the last sync.
- A daily summary is sent at 23:00 local time if you read anything that day.

**GitHub:**
- Provide a Personal Access Token (fine-grained, Contents read/write), repo owner, repo name, and file path.
- Each sync pushes a full JSON snapshot of all readings (with highlights and notes) to the repo.
- **Restore from GitHub**: Pulls the JSON from the repo and merges missing readings into local storage.
- **Restore from File**: Same merge from a local `.json` backup.

**Auto-sync:**
- Configurable interval (default: 60 minutes, range: 1–1440).
- Runs automatically via a Chrome alarm. Only fires if at least one sync channel is configured.

### Auto-Classification

Readings are automatically tagged on creation using a keyword scoring system:

| Signal | Weight |
|---|---|
| Title keyword match | 3 pts |
| URL pattern match | 4 pts |
| Content keyword match | 1 pt |
| Title keyword in content | 0.5 pts |

A minimum score of 2.5 is required; otherwise the reading is tagged `General Learning`. Manual tag selections in the popup always take priority.

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
| `Cmd/Ctrl+F` | Open in-document search |
| `Cmd/Ctrl+ +` or `=` | Zoom in |
| `Cmd/Ctrl+ -` | Zoom out |
| `Cmd/Ctrl+0` | Reset zoom (150%) |
| `Cmd/Ctrl+S` | Save notes |
| `Escape` | Close search / exit highlight mode / dismiss popovers |
| `Enter` | Next search match |
| `Shift+Enter` | Previous search match |
| `Cmd/Ctrl+Enter` | Save note (in edit textarea) |

### Web Pages
| Key | Action |
|---|---|
| `Escape` | Exit highlight mode / close sidebar |
| `Cmd/Ctrl+S` | Save note (in sidebar) |

---

## Data Storage

| Data | Location |
|---|---|
| Reading metadata, highlights, scroll positions | `chrome.storage.local` |
| Sync credentials | `chrome.storage.sync` |
| PDF files + extracted text | IndexedDB (`marginaliaDB`) |

Web page keys use `origin + pathname`. Library PDF keys use a content hash: `library:{sha256prefix}-{size}-{filename}`.
