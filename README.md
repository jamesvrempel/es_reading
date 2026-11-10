# ES Reading

A read-along app for young readers (ages 6+), built on the Frappe Framework.

A grown-up signs in at `/reading`, adds each child as a reader, and picks a PDF from the library.
The narrator reads a few lines aloud, the child reads the same lines back, and the app helps with a
word when the child pauses. At the end it compares the child's reading time with the narrator's and
suggests what to do next.

## Install

On the bench that hosts the site (run as the bench user):

```bash
cd ~/frappe-bench
bench get-app https://github.com/jamesvrempel/es_reading --branch main
bench --site reading.enterprisesystems.com.au install-app es_reading
bench restart
```

`bench get-app` clones the repository into `apps/es_reading`, installs it into the bench's Python
environment, adds it to `sites/apps.txt` and builds its assets. There is nothing to compile: the app
has no Node dependencies, and PDF.js is bundled.

## Update

```bash
cd ~/frappe-bench
git -C apps/es_reading pull
bench --site reading.enterprisesystems.com.au migrate
bench build --app es_reading
bench restart
```

`bench update --apps es_reading` does the same, but migrates every site on the bench.

## Uninstall

```bash
bench --site reading.enterprisesystems.com.au uninstall-app es_reading
bench remove-app es_reading
```

Uninstalling deletes the books, readers and sessions on that site.

Then open **ES Reading Settings** in the Desk:

1. Paste a Claude API key and press **Test Claude connection**.
2. Decide whether to tick **Sign-up not required**, which opens `/reading` to visitors without an account.
3. Check the defaults for new readers (lines per turn, silence before help, time gap, voice).

The Desk has an **ES Reading** workspace (visible to System Managers and Reading Librarians) with
shortcuts to the app, books, readers and sessions, four number cards, a weekly sessions chart and
links to the settings.

The `/reading` page carries the website's own top menu (logo, search, the links from **Website
Settings → Top Bar** and the account menu), so changes made there show up in the app. The menu is
hidden while a child is reading so nothing distracts from the page.

To make `/reading` the site's front page, set **Website Settings → Home Page** to `reading`.

## Who can do what

| Who | How they get access | What they can do |
| --- | --- | --- |
| Family | Any signed-in user (for example an approved ES Signup account). No role needed. | Add their own readers, read books, see their own children's progress. |
| Guest | Only when **Sign-up not required** is ticked in ES Reading Settings | Read the published books. Readers and progress are kept in that browser only, never on the server; feedback is the standard text rather than Claude's. |
| Teacher | Role **Reading Teacher** | Make classes at `/reading`, assign books and see the progress of readers who joined. |
| Librarian | Role **Reading Librarian** (or System Manager) | Add, prepare, hide and delete books at `/reading`; edit book lines and tricky words in the Desk. |
| Administrator | System Manager | Settings, plus all readers and sessions in the Desk. |

A family can only ever see its own readers and sessions. Children have no accounts of their own, and
only a first name or nickname is stored. No audio is recorded or stored.

## Adding books

At `/reading`, a librarian presses **Add a book** and chooses a PDF. The browser finds each line of
text and where it sits on the page, then the server asks Claude for the reading level, a one-line
summary, the lines that should not be read aloud (page numbers, name and score blanks, answer keys)
and up to 20 tricky words with syllables and child-friendly meanings.

- A scanned PDF with no text layer is transcribed by Claude instead (needs the API key).
- To change what is read, open the **Reading Book** in the Desk and tick **Don't read** on any line,
  or edit the tricky words. **Re-scan** at `/reading` starts the preparation again from the PDF.
- Each book's picture is page 1 of the PDF by default. Press **Picture** on a book to use your own image; it is
  kept when the book is re-scanned, and **Use page 1 again** switches back.
- PDFs are stored as public files under `/files`.

## How a session works

| Setting | Default | Where |
| --- | --- | --- |
| Lines per turn | 10 | Reader settings (⚙) |
| Help after a pause of | 4 seconds | Reader settings |
| Suggest practice when the child takes longer than the narrator by | 20% | Reader settings |
| Accent, male or female voice, exact device voice, speed | Australia, female, 0.9 | Reader settings |

- Turns never run across a page, and a turn is stretched by up to three lines so it ends on a full sentence.
- **Listening** uses the browser's speech recognition (Chrome, Edge, Safari). The child's reading is
  followed word by word. If the pointer has not moved for the pause length, the narrator says the
  word; a second pause on the same word moves past it. Tapping any word also says it.
- Where the browser cannot listen (Firefox, or the microphone is blocked) the child reads, taps words
  for help, and taps **I've read it**.
- **Timing**: the child's time is the time spent in their own turns. The narrator's time is measured
  while it reads aloud; in "I'll read it myself" mode it is estimated from the narrator's measured pace.
- When the gap is above the threshold the results page leads with three options: read it again,
  practise the tricky words, or listen to the whole story.

## For readers and families

- **Carry on later**: leaving a book part-way saves the place, and opening it again offers to carry on from that page.
- **My words**: every word a reader needed help with goes into their word bank. Practising a word correctly
  three times in a row moves it to "words you know now"; needing help with it again brings it back.
- **Syllables first**: when a reader is stuck, the word is first shown in pieces, then said aloud after a
  second pause, and skipped after a third. The pieces come from Claude's notes for the book where they exist,
  otherwise from a rule of thumb, so they are a hint and not a dictionary. Turn it off per reader in Settings.
- **Badges and streaks**: ten badges for books read, days in a row, reading without help and word practice.
- **Progress**: books read, minutes, streak, words mastered, charts of words a minute and words needing help.
- **Just right**: books within a year of the reader's level are marked and listed first. The level is the
  optional "Reading level (age)" in Settings, or is worked out from books read with little help.
- **How the words look**: lettering (standard or Lexend), text size, spacing and background per reader.
- **Home screen**: the page can be added to a tablet's home screen and opens full screen.

## For librarians

**Manage** on a book gives: re-scan, picture, title/shelf/level, pages to read, hide/show and delete.

- **Shelves** group books in the library; with shelves set (or more than six books) a search box and shelf
  buttons appear.
- **Pages to read** leaves out whole pages, such as questions or an answer key. It survives a re-scan.

## Recorded narrator voice (optional)

By default the narrator is each device's own voice. With an Azure Speech key the narrator can be recorded
once per book in a natural voice that every device then plays.

1. In the Azure portal create a **Speech** resource. The **Free (F0)** pricing tier covers half a million
   characters a month; a typical short book is a few thousand characters per voice.
2. In **ES Reading Settings** set Narrator to **Azure Speech** and enter the key and the resource's region
   (for example `australiaeast`).
3. At `/reading`, a librarian opens **Manage → Narrator's voice** on a book, ticks the voices to record
   (accent and male or female) and presses **Record**. It runs in the background, slowly on purpose so the
   free tier's request limit is not hit.

Readers hear the recording that matches their accent and voice setting. Sentences that have no recording,
and single words said as help, are read by the device's voice. Only the book's text is sent to Azure.

## Questions, recordings, classes and email

- **Questions about the story**: Claude writes four multiple-choice questions when it prepares a book, and
  they can be edited on the Reading Book in the Desk. After reading, the results page offers them.
- **Hear yourself read** (per reader, off by default): each turn is recorded in the browser and can be
  played back on the results page. Recordings are never uploaded and are discarded on leaving that page.
- **Classes**: give a teacher the **Reading Teacher** role. At `/reading` they make a class, share its
  six-letter code and assign books. A family joins by typing the code into a reader's Settings, which shares
  that reader's name and reading progress with the teacher; they can leave at any time.
- **Weekly email**: tick **Email families a weekly reading summary** in ES Reading Settings. Each family
  that read during the week gets one email, and can turn it off on the "Who's reading" page.

## Other formats

**Add a book** accepts PDF and EPUB files, or text typed or pasted in. EPUB and typed books are read as
text: their pictures are not shown and there is no page image, so the page side shows the text instead.

## Voices

Voices come from the device, not from the server. Each device offers a different set, and browsers do
not say whether a voice is male or female, so the app recognises the common voice names. If a device
has no voice for the chosen accent and gender, the library page says which voice it is using instead,
and reader settings let you pick any exact voice on that device.

## Data model

- **ES Reading Settings** (single): Claude key and model, defaults, limits.
- **Reading Book**: PDF, cover, status, lines (text, page, position, don't-read flag), tricky words.
- **Reader Profile**: name, avatar, family account, voice and turn preferences.
- **Reading Session**: reader, book, mode, times, gap, words helped, feedback.

Because these are ordinary DocTypes, they are also visible to Claude through Frappe Assistant Core
(for example "how has READER-00001 progressed this month?").

## Licence

MIT, see `LICENSE`. PDF.js 3.11.174 (Apache-2.0) is bundled under `es_reading/public/vendor/pdfjs`
and the Lexend font (SIL Open Font License) under `es_reading/public/fonts`, each with its licence file.
