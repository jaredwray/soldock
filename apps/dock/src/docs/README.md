# `docs` module

> Status: **started**. The first layer exists: create, read and replace the content of a doc, as
> a block tree and as Markdown, and the images of a doc. Keep this README current as the module
> grows. It is the module's contract.

| | |
| --- | --- |
| **Purpose** | Server-side Docs operations: read/edit/create via the collab harness, Markdown/DOCX/HTML/PDF conversion, text extraction for search. |
| **Owns** | No own store (content lives in `DocumentDO`). |
| **Depends on** | `platform`, `identity`, `collab`, `drive`, and the URL rules of `webhooks`. |
| **Operations** | `docs.create`, `docs.get`, `docs.update`, `docs.upload_image`, `docs.copy_image`, `docs.import_image`, `docs.get_image` |
| **Data inventory** | None of its own (content and the list of the images in `DocumentDO`, the bytes of the images in R2, the item in `DriveSpaceDO`). See [`collab`](../collab/README.md#data-inventory). DOCX/Markdown in Takeout. |

Public surface: `index.ts` only. Other domains must not import files from this folder directly.

## What exists

| File | What |
| --- | --- |
| `handlers.ts` | The operation handlers. They ask the drive for the item and the role, then read or write the `DocumentDO` |
| `content.ts` | The empty doc, the limit of blocks in blocks, the images of a doc, and the text of a doc for the search index |
| `markdown.ts` | Markdown to content, and content to Markdown |
| `image.ts` | The type and the size in pixels of an image file, from its bytes |

## A doc

- A doc is a Drive item of the kind `doc`. The [`drive`](../drive/README.md) module owns the item:
  its name, its folder, the access, the trash and the search index.
- The content is a tree of blocks in the JSON form of ProseMirror (`DocContent` in
  `@soldock/contracts`). It is data, never HTML, so no script and no style can be in it.
  - Blocks: `paragraph`, `heading` (level 1 to 3), `bullet_list`, `ordered_list`, `list_item`,
    `blockquote`, `code_block` and `horizontal_rule`. Inline: `text`, `hard_break` and `image`.
  - Marks: `strong`, `em`, `underline`, `strike`, `code` and `link`. A link is an absolute `http`,
    `https` or `mailto` URL.
- The schema refuses each other node, mark and attribute at the boundary. The handler also
  refuses more than 12 levels of blocks in blocks, and content over 1 MiB of JSON.
- The editor of the web app has the same tree as its document model. It sends `content`.

## Operations

- `docs.create` makes the item and, with `markdown` or `content`, the first revision. It takes an
  idempotency key. When a first call stops after the item and before the content, a second call
  with the same key writes the content.
- `docs.get` needs the viewer role. It returns `content`, `markdown` and `revision`.
- `docs.update` needs the editor role. It replaces the whole content.
  - With `base_revision`, a change from an old revision gets `conflict` and changes nothing. The
    web app sends it with each save.
  - The same content changes nothing and makes no revision.
  - A doc in the trash refuses the change.
- After a change, the item in the drive has the new size, time and author, and the search index
  has the new text (first 100,000 characters). The alt text and the caption of each image are in
  that text.

## Images

A doc holds its own images. An image is not an item of Drive: its access, its copy and its delete
follow the doc.

### What a doc holds

- An image is an attachment of the `DocumentDO` of the doc ([`collab`](../collab/README.md#attachments)).
  The row has the id (`img_…`), the R2 key, the bytes, and what this module knows: the type, the
  pixels, the name and the `untrusted` mark.
- The bytes are one R2 object: `document/<item id>/<image id>`. R2 stores it as
  `application/octet-stream`. The key has no drive, so a move between drives changes no key.
- An id is good in its doc only. The bytes of an id never change.
- A doc holds at most 200 images (`DOC_LIMITS.images`), with the images that the content does not
  use. One image has at most 10 MiB, 16,384 pixels on a side and 64 million pixels.
- The file is a PNG, JPEG, GIF or WebP image. `image.ts` reads the type and the pixels from the
  bytes. The server never uses the type that a client or a web server gave. For a JPEG file, the
  EXIF orientation is applied, because a browser shows the image that way. For a GIF file, the
  size is the larger of the screen and the first picture. An SVG image is refused:
  it can hold a script.
- `docs.get` returns `images`: each image that the doc holds. `docs.get_image` returns the bytes
  of one image as base64. The bytes never go to a browser from this origin as a page or as an image
  address. The web app makes a `blob:` address from them.

### An image in the content

The `image` node is in the text of a paragraph or a heading. It has no bytes and no address.

| Attribute | Value |
| --- | --- |
| `id` | The id of an image that the doc holds. `docs.update` refuses a different id with `invalid` |
| `width` | The shown width in CSS pixels, 16 to 4096. The height follows from the shape of the image. Without it, the image gets the width of its shown part, at most 654 (the width of the text in the web app) |
| `layout` | `inline` (the default): in the line, as a character. `wrap_left`, `wrap_right`: at that side, and the text goes around it. `break_left`, `break_center`, `break_right`: on its own line |
| `alt` | The text for a person who cannot see the image. One line, at most 1,000 characters |
| `caption` | The line below the image. One line, at most 500 characters |
| `crop` | The part that shows: `x`, `y`, `width`, `height`, each a part of the file from 0 to 1. The doc keeps the whole file |

- The handler stores each number of a crop with 4 decimals, and keeps the crop in the image with
  each side at 1% or more. A crop of the whole image goes away. The completed content gets the
  check of the schema again before it goes into storage.
- `docs.create` refuses content with an image, because a new doc holds no image.

### Add an image

| Operation | Source | Notes |
| --- | --- | --- |
| `docs.upload_image` | Bytes as base64 | |
| `docs.copy_image` | An image file of Drive (`from_item_id`), or an image of a different doc (`from_item_id` and `from_image_id`) | Needs the viewer role for the source. An image of a doc keeps its id, and a second copy returns the first one |
| `docs.import_image` | A web address | See [An image from a web address](#an-image-from-a-web-address) |

- Each one needs the editor role for the doc, and refuses a doc in the trash.
- The handler writes the bytes to R2, then records the image in the `DocumentDO`. When the object
  refuses (the doc is full), the handler deletes the R2 object of that attempt.
- The new image is not in the text. `docs.update` puts it there.
- These operations take no idempotency key. A second call makes a second image, and the document
  object deletes the image that the content does not use.

### An image from a web address

`docs.import_image` downloads the address one time. The doc never loads the address again, so a
reader of the doc sends no request to that server.

- The address follows the rules of a webhook URL (`publicUrlProblem`): https, the default port, a
  public host name, no IP address, no user name, and not the host of the deployment.
- The request has no cookie and no credential. It follows at most 3 redirects, and each redirect
  gets the same checks. The whole download has 15 seconds and stops at 10 MiB.
- The **outbound policy** of an agent applies, also to each redirect: an address can carry data out
  in its path. Mode `internal-only` allows no import. A refusal is `policy_denied`.
- The image is content from outside the organization: it has `untrusted: true`, also after a copy
  into a different doc. An image from Drive is not marked, because Drive holds no content from
  outside yet ([`drive`](../drive/README.md#safety)).

### The life of an image

- Each `docs.update` gives the `DocumentDO` the ids of the images in the new content. An image
  that the content does not use is deleted 24 hours after its last use, with its bytes. In that time,
  an Undo in an editor can put the image back.
- A new image counts as not used until a `docs.update` uses it.
- `drive.copy_item` copies the images that the content uses to the copy, with the same ids.
- A permanent delete of the doc deletes the bytes of each image.

## Markdown

Markdown is the form for agents and for the download in the web app.

- `markdownToDoc` reads: headings (`#` to `######`, levels over 3 become level 3), paragraphs,
  `**strong**`, `*em*`, `~~strike~~`, `` `code` ``, `[text](url)`, `<url>`, bulleted and numbered
  lists with levels, `>` quotes, code fences, `---` rules, and hard breaks (two spaces or a
  backslash at the end of a line).
- With the option `lineBreaks`, each new line in a paragraph is a hard break, as in a chat. The
  `chat` module uses it. Without it, Markdown joins the lines of a paragraph with a space.
- An image of the doc is `![alt](image:img_… "caption")`. The options are a query after the id:
  `?width=320&layout=wrap_left&crop=0.1,0.1,0.8,0.8`. Markdown keeps each option, so an agent that
  changes the text with Markdown does not change the images. An option with a bad value is refused
  with `invalid`.
- Only the handlers of this module read an image (the option `images`). The `chat` module reads
  Markdown without it, and a chat message has no image.
- Text that is not Markdown of this subset stays text: HTML, tables, and an image with a web
  address or a `data:` address are not read.
- The handler checks the result against `DocContent` before it stores it. Markdown that makes
  content over a limit, for example one text of more than 100,000 characters, gets `invalid`. A
  list number has at most 5 digits, and a longer number is text.
- A link with a different scheme than `http`, `https` or `mailto` keeps its text and loses its
  target.
- `docToMarkdown` writes Markdown that `markdownToDoc` reads back to the same doc. It escapes text
  that looks like Markdown. Two lists of one kind, one after the other, get different marks.
- Markdown has no underline and no empty paragraph. An update with `markdown` loses those. Each
  other format stays.
- The parser and the writer do work in proportion to the length of the text, so hostile input
  cannot use up the CPU time of a request. Blocks in blocks stop at the limit, and deeper lines
  become text. At most 32 emphasis marks can be open at one time: a further mark stays text. A run of
  more than 6 of one emphasis character is text too.

## Not built yet

- Real-time editing by more than one person (see [`collab`](../collab/README.md))
- Changes to a part of a doc (insert, replace a range), comments and suggestions
- Version history of a doc
- Tables, text color, alignment, and page layout
- Import and export of DOCX, HTML and PDF. The Markdown of a doc names its images by id, and has no
  image files
- A link on an image, a turn or a flip of an image, and an image behind or in front of the text
- An image over 10 MiB, and thumbnails made on the server
- A storage quota for the images of a doc. The size of the item in Drive does not count them
- An operation that deletes one image at once. The image goes away 24 hours after its last use
