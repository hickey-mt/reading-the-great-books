import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY,
  SITE_TITLE, SITE_KICKER, SITE_INTRO, HERO_IMAGE,
} from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const state = {
  books: [],
  tab: 'full',
  search: '',
  filters: { author: '', yearRead: '', yearPublished: '', fiction: '', genre: '' },
  sort: { column: 'authors', direction: 'asc' },
  user: null,
  selectMode: false,
  selected: new Set(),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ===================== Hero setup ===================== */

function setupHero() {
  document.title = SITE_TITLE;
  $('#site-bar-title').textContent = SITE_TITLE;
  $('#hero-title').textContent = SITE_TITLE;
  $('#hero-kicker').textContent = SITE_KICKER;
  $('#hero-intro').textContent = SITE_INTRO;
  if (HERO_IMAGE) {
    $('#hero').style.backgroundImage = `url("${HERO_IMAGE}")`;
  }
}

/* ===================== Supabase / data ===================== */

async function fetchBooks() {
  const { data, error } = await sb.from('books').select('*').order('created_at', { ascending: false });
  if (error) { console.error('Fetch books error:', error); return []; }
  return data || [];
}

async function upsertBook(book) {
  if (book.id) {
    const { data, error } = await sb.from('books').update(book).eq('id', book.id).select().single();
    if (error) throw error;
    return data;
  }
  const { id, ...newBook } = book;
  const { data, error } = await sb.from('books').insert(newBook).select().single();
  if (error) throw error;
  return data;
}

async function deleteBook(id) {
  const { error } = await sb.from('books').delete().eq('id', id);
  if (error) throw error;
}

/* ===================== Open Library ===================== */

const COVER = (cover_i, size = 'M') => cover_i ? `https://covers.openlibrary.org/b/id/${cover_i}-${size}.jpg` : null;
const ISBN_COVER = (isbn, size = 'M') => isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg` : null;

async function olSearch(query) {
  if (!query.trim()) return [];
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=15&fields=key,title,subtitle,author_name,first_publish_year,cover_i,isbn,publisher,subject,number_of_pages_median`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open Library search failed');
  const j = await r.json();
  return j.docs || [];
}

function olToBook(doc) {
  const subjects = (doc.subject || []).slice(0, 20);
  const isFiction = subjects.some((s) => /^fiction$/i.test(s)) ? true
                  : subjects.some((s) => /^non[- ]?fiction$/i.test(s)) ? false
                  : null;
  return {
    open_library_id: doc.key,
    title: doc.title || 'Untitled',
    subtitle: doc.subtitle || null,
    authors: doc.author_name || [],
    publisher: (doc.publisher && doc.publisher[0]) || null,
    year_published: doc.first_publish_year || null,
    cover_url: COVER(doc.cover_i, 'L') || ISBN_COVER(doc.isbn?.[0], 'L'),
    isbn: doc.isbn?.[0] || null,
    page_count: doc.number_of_pages_median || null,
    subjects,
    genres: filterSubjects(subjects).slice(0, 4),
    is_fiction: isFiction,
    status: 'want_to_read',
    current_page: 0,
  };
}

function filterSubjects(subjects) {
  const BLOCK = /(fiction|non-?fiction|literature|protected daisy|accessible book|in library|new york times)/i;
  const seen = new Set();
  return subjects
    .filter((s) => !BLOCK.test(s))
    .filter((s) => s.length < 32 && !s.includes('--'))
    .filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ===================== Filtering / sorting ===================== */

function visibleBooks() {
  let out = state.books;
  if (state.tab === 'reading') out = out.filter((b) => b.status === 'reading');
  else if (state.tab === 'completed') out = out.filter((b) => b.status === 'finished');
  else if (state.tab === 'want') out = out.filter((b) => b.status === 'want_to_read');
  // 'full' tab shows everything
  if (state.filters.author) out = out.filter((b) => (b.authors || []).includes(state.filters.author));
  if (state.filters.yearRead) out = out.filter((b) => b.date_finished && b.date_finished.startsWith(state.filters.yearRead));
  if (state.filters.yearPublished) out = out.filter((b) => String(b.year_published) === state.filters.yearPublished);
  if (state.filters.fiction !== '') {
    const want = state.filters.fiction === 'true';
    out = out.filter((b) => b.is_fiction === want);
  }
  if (state.filters.genre) out = out.filter((b) => (b.genres || []).includes(state.filters.genre));
  if (state.search) {
    const q = state.search.toLowerCase();
    out = out.filter((b) =>
      (b.title || '').toLowerCase().includes(q) ||
      (b.authors || []).some((a) => a.toLowerCase().includes(q)) ||
      (b.notes || '').toLowerCase().includes(q),
    );
  }
  return sortBooks(out);
}

function sortBooks(books) {
  if (state.tab !== 'full') {
    // Cover-grid tabs: primary sort by tab-specific date, fallback to created_at desc.
    const primaryKey = state.tab === 'completed' ? 'date_finished'
                     : state.tab === 'reading' ? 'date_started'
                     : 'created_at';
    return [...books].sort((a, b) => {
      const ap = a[primaryKey] || '';
      const bp = b[primaryKey] || '';
      if (ap !== bp) return bp.localeCompare(ap);
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  }
  const { column, direction } = state.sort;
  const sign = direction === 'asc' ? 1 : -1;
  return [...books].sort((a, b) => {
    let av = a[column], bv = b[column];
    if (column === 'authors') {
      av = (a.authors || [])[0] || '';
      bv = (b.authors || [])[0] || '';
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * sign;
    return (av < bv ? -1 : av > bv ? 1 : 0) * sign;
  });
}

/* ===================== Rendering ===================== */

function statusLabel(s) {
  return { reading: 'Reading', finished: 'Finished', want_to_read: 'Future' }[s] || s;
}

function escape(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  renderFilterOptions();
  const container = $('#content');
  const books = visibleBooks();

  if (books.length === 0) {
    const empty = state.books.length === 0
      ? (state.user ? 'No books yet. Click <strong>Add a book</strong> to start your library.' : 'No books yet.')
      : 'No books match your filters.';
    container.innerHTML = `<div class="state-message">${empty}</div>`;
    return;
  }

  if (state.tab === 'full') {
    container.innerHTML = tableHtml(books);
    wireTableSorting();
  } else {
    container.innerHTML = coverSectionHtml(state.tab, books);
  }

  $$('.book-row, .cover-tile').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (state.selectMode) {
        e.preventDefault();
        const id = el.dataset.id;
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
        el.classList.toggle('is-selected');
        updateSelectionBar();
      } else {
        openBookDetail(el.dataset.id);
      }
    });
  });
}

function tableHtml(books) {
  const arrow = (col) => state.sort.column !== col
    ? '<span class="sort-arrow">↕</span>'
    : `<span class="sort-arrow">${state.sort.direction === 'asc' ? '↑' : '↓'}</span>`;
  const cls = (col) => state.sort.column === col ? `sort-${state.sort.direction}` : '';

  const rows = books.map((b, i) => {
    const authors = (b.authors || []).join(', ') || '—';
    const rating = b.rating ? '★'.repeat(b.rating) : '';
    const tags = (b.genres || []).join(', ');
    const selClass = state.selected.has(b.id) ? ' is-selected' : '';
    return `<tr class="book-row${selClass}" data-id="${b.id}">
      <td class="col-number">${i + 1}</td>
      <td class="col-author">${escape(authors)}</td>
      <td class="col-title">${escape(b.title)}${b.subtitle ? `<span class="book-subtitle">${escape(b.subtitle)}</span>` : ''}</td>
      <td class="col-year">${b.year_published ?? ''}</td>
      <td class="col-tags">${escape(tags)}</td>
      <td class="col-status"><span class="status-pill status-${b.status}">${statusLabel(b.status)}</span></td>
      <td class="col-rating">${rating}</td>
    </tr>`;
  }).join('');

  return `<table class="book-table">
    <thead><tr>
      <th class="col-number" data-sort="created_at">#</th>
      <th data-sort="authors" class="${cls('authors')}">Author ${arrow('authors')}</th>
      <th data-sort="title" class="${cls('title')}">Title ${arrow('title')}</th>
      <th data-sort="year_published" class="${cls('year_published')}">Year ${arrow('year_published')}</th>
      <th class="col-tags">Tags</th>
      <th data-sort="status" class="${cls('status')}">Status ${arrow('status')}</th>
      <th data-sort="rating" class="${cls('rating')}">Rating ${arrow('rating')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function wireTableSorting() {
  $$('.book-table thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (col === 'created_at') return;
      if (state.sort.column === col) {
        state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.column = col;
        state.sort.direction = 'asc';
      }
      render();
    });
  });
}

function coverSectionHtml(tab, books) {
  const titleMap = { reading: 'Currently Reading', completed: 'Completed', want: 'Future Reading' };
  const subMap = {
    reading: 'Books I’m working through right now.',
    completed: 'Books I’ve finished, most recent first. Click any cover for notes and details.',
    want: 'Books I plan to read next.',
  };
  return `<h2 class="section-heading">${titleMap[tab] || ''}</h2>
    <p class="section-sub">${subMap[tab] || ''}</p>
    <div class="cover-grid">${books.map(coverTileHtml).join('')}</div>`;
}

function coverTileHtml(b) {
  const authors = (b.authors || [])[0] || '';
  const progress = b.status === 'reading' && b.page_count && b.current_page
    ? `<div class="cover-tile-progress"><div class="cover-tile-progress-fill" style="width:${Math.min(100, (b.current_page / b.page_count) * 100)}%"></div></div>`
    : '';
  const cover = b.cover_url
    ? `<img src="${escape(b.cover_url)}" alt="${escape(b.title)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
       <div class="cover-tile-placeholder" style="display:none;">${escape(b.title)}</div>`
    : `<div class="cover-tile-placeholder">${escape(b.title)}</div>`;
  const selClass = state.selected.has(b.id) ? ' is-selected' : '';
  return `<button class="cover-tile${selClass}" data-id="${b.id}">
    <div class="cover-tile-img">${cover}${progress}</div>
    <span class="cover-tile-title">${escape(b.title)}</span>
    ${authors ? `<span class="cover-tile-author">${escape(authors)}</span>` : ''}
  </button>`;
}

function renderFilterOptions() {
  const authors = new Set();
  const yearsRead = new Set();
  const yearsPub = new Set();
  const genres = new Set();
  for (const b of state.books) {
    for (const a of b.authors || []) authors.add(a);
    if (b.date_finished) yearsRead.add(b.date_finished.slice(0, 4));
    if (b.year_published) yearsPub.add(String(b.year_published));
    for (const g of b.genres || []) genres.add(g);
  }
  fillSelect('#filter-author', [...authors].sort(), state.filters.author, 'All authors');
  fillSelect('#filter-year-read', [...yearsRead].sort().reverse(), state.filters.yearRead, 'Any year read');
  fillSelect('#filter-year-published', [...yearsPub].sort().reverse(), state.filters.yearPublished, 'Any year published');
  fillSelect('#filter-genre', [...genres].sort(), state.filters.genre, 'All tags');
  const anyActive = Object.values(state.filters).some((v) => v) || state.search;
  $('#clear-filters').hidden = !anyActive;
}

function fillSelect(sel, options, current, defaultLabel) {
  const el = $(sel);
  el.innerHTML = `<option value="">${defaultLabel}</option>` + options.map((o) => `<option value="${escape(o)}" ${o === current ? 'selected' : ''}>${escape(o)}</option>`).join('');
}

/* ===================== Book detail modal ===================== */

function openBookDetail(id) {
  const book = state.books.find((b) => b.id === id);
  if (!book) return;
  $('#book-modal-content').innerHTML = bookDetailHtml(book);
  showModal('#book-modal');
  const editBtn = $('#book-modal-content #edit-book');
  if (editBtn) editBtn.addEventListener('click', () => showEditForm(book));
  const delBtn = $('#book-modal-content #delete-book');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${book.title}"? This cannot be undone.`)) return;
    try {
      await deleteBook(book.id);
      state.books = state.books.filter((b) => b.id !== book.id);
      hideModal('#book-modal');
      render();
    } catch (e) { alert('Delete failed: ' + e.message); }
  });
}

function bookDetailHtml(b) {
  const authors = (b.authors || []).join(', ');
  const rating = b.rating ? `<span style="color:var(--gold);letter-spacing:1px;">${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}</span>` : '—';
  const genres = (b.genres || []).map((g) => `<span class="tag tag-genre">${escape(g)}</span>`).join('');
  const cover = b.cover_url
    ? `<img src="${escape(b.cover_url)}" alt="${escape(b.title)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
       <div class="cover-tile-placeholder" style="display:none;">${escape(b.title)}</div>`
    : `<div class="cover-tile-placeholder">${escape(b.title)}</div>`;
  const progressLine = b.status === 'reading' && b.page_count
    ? `<div><strong>Progress:</strong> page ${b.current_page || 0} of ${b.page_count} (${Math.round(((b.current_page || 0) / b.page_count) * 100)}%)</div>`
    : '';
  return `<div class="book-detail">
    <div class="cover-col">${cover}</div>
    <div>
      <h2>${escape(b.title)}${b.subtitle ? `<span style="display:block;font-size:18px;font-weight:400;color:var(--ink-muted);margin-top:4px;font-style:italic;">${escape(b.subtitle)}</span>` : ''}</h2>
      <div class="book-detail-author">${escape(authors) || 'Unknown author'}</div>
      <div class="tags">
        <span class="tag">${statusLabel(b.status)}</span>
        ${b.is_fiction === true ? '<span class="tag">Fiction</span>' : b.is_fiction === false ? '<span class="tag">Non-fiction</span>' : ''}
        ${genres}
      </div>
      <div class="book-detail-meta">
        ${b.publisher ? `<div><strong>Publisher:</strong> ${escape(b.publisher)}</div>` : ''}
        ${b.year_published ? `<div><strong>Year published:</strong> ${escape(b.year_published)}</div>` : ''}
        ${b.page_count ? `<div><strong>Pages:</strong> ${b.page_count}</div>` : ''}
        ${b.isbn ? `<div><strong>ISBN:</strong> ${escape(b.isbn)}</div>` : ''}
        ${progressLine}
        <div><strong>Rating:</strong> ${rating}</div>
        ${b.date_started ? `<div><strong>Started:</strong> ${escape(b.date_started)}</div>` : ''}
        ${b.date_finished ? `<div><strong>Finished:</strong> ${escape(b.date_finished)}</div>` : ''}
      </div>
      ${b.notes ? `<div class="book-detail-notes">${escape(b.notes)}</div>` : ''}
      ${state.user ? `<div class="book-detail-actions">
        <button id="edit-book" class="btn btn-primary">Edit</button>
        <button id="delete-book" class="btn btn-danger">Delete</button>
      </div>` : ''}
    </div>
  </div>`;
}

function showEditForm(book) {
  $('#book-modal-content').innerHTML = editFormHtml(book);
  wireEditForm(book);
}

function editFormHtml(b) {
  return `<h2>Edit book</h2>
  <p class="modal-subtitle">${escape(b.title)}</p>
  <form id="edit-form">
    <div class="form-row">
      <label>Status
        <select name="status">
          <option value="want_to_read" ${b.status === 'want_to_read' ? 'selected' : ''}>Future reading</option>
          <option value="reading" ${b.status === 'reading' ? 'selected' : ''}>Reading</option>
          <option value="finished" ${b.status === 'finished' ? 'selected' : ''}>Finished</option>
        </select>
      </label>
      <label>Fiction / non-fiction
        <select name="is_fiction">
          <option value="" ${b.is_fiction == null ? 'selected' : ''}>—</option>
          <option value="true" ${b.is_fiction === true ? 'selected' : ''}>Fiction</option>
          <option value="false" ${b.is_fiction === false ? 'selected' : ''}>Non-fiction</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label>Current page
        <input type="number" name="current_page" min="0" value="${b.current_page ?? 0}">
      </label>
      <label>Total pages
        <input type="number" name="page_count" min="0" value="${b.page_count ?? ''}">
      </label>
    </div>
    <div class="form-row">
      <label>Date started
        <input type="date" name="date_started" value="${b.date_started ?? ''}">
      </label>
      <label>Date finished
        <input type="date" name="date_finished" value="${b.date_finished ?? ''}">
      </label>
    </div>
    <label>Rating (1–5)
      <select name="rating">
        <option value="" ${!b.rating ? 'selected' : ''}>—</option>
        ${[1,2,3,4,5].map(n => `<option value="${n}" ${b.rating === n ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}
      </select>
    </label>
    <label>Tags (comma-separated)
      <input type="text" name="genres" value="${escape((b.genres || []).join(', '))}" placeholder="e.g. Fantasy, Memoir">
    </label>
    <label>Cover image URL <span style="font-weight:400;color:var(--ink-muted);font-size:12px;">— right-click a cover anywhere (Amazon, Google Books, Goodreads), copy image address, paste here</span>
      <input type="url" name="cover_url" value="${escape(b.cover_url || '')}" placeholder="https://...">
    </label>
    <label>Notes
      <textarea name="notes" rows="5">${escape(b.notes || '')}</textarea>
    </label>
    <div id="edit-error" class="form-error" hidden></div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button type="submit" class="btn btn-primary">Save</button>
      <button type="button" class="btn btn-ghost" id="cancel-edit">Cancel</button>
    </div>
  </form>`;
}

function wireEditForm(book) {
  const form = $('#edit-form');
  $('#cancel-edit').addEventListener('click', () => openBookDetail(book.id));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const patch = {
      id: book.id,
      status: data.get('status'),
      is_fiction: data.get('is_fiction') === '' ? null : data.get('is_fiction') === 'true',
      current_page: data.get('current_page') ? Number(data.get('current_page')) : 0,
      page_count: data.get('page_count') ? Number(data.get('page_count')) : null,
      date_started: data.get('date_started') || null,
      date_finished: data.get('date_finished') || null,
      rating: data.get('rating') ? Number(data.get('rating')) : null,
      genres: (data.get('genres') || '').split(',').map((s) => s.trim()).filter(Boolean),
      cover_url: data.get('cover_url') || null,
      notes: data.get('notes') || null,
    };
    try {
      const updated = await upsertBook(patch);
      const idx = state.books.findIndex((b) => b.id === updated.id);
      if (idx >= 0) state.books[idx] = updated;
      render();
      openBookDetail(book.id);
    } catch (err) {
      const e = $('#edit-error');
      e.textContent = err.message;
      e.hidden = false;
    }
  });
}

/* ===================== Add book flow ===================== */

let olSearchTimer = null;

function openAddModal() {
  const panel = $('#add-modal .modal-panel');
  panel.innerHTML = `<button class="modal-close" data-close aria-label="Close">×</button>
    <h2 id="add-title">Add a book</h2>
    <p class="modal-subtitle">Search by title or author. Results come from Open Library.</p>
    <div class="search-row">
      <input type="search" id="ol-search" placeholder="e.g. Middlemarch George Eliot" autocomplete="off" autofocus>
      <button id="ol-search-btn" class="btn btn-primary">Search</button>
    </div>
    <div id="ol-results" class="ol-results"></div>
    <p style="margin-top:20px;padding-top:16px;border-top:1px solid var(--rule);text-align:center;font-size:13px;color:var(--ink-muted);">
      Can’t find it? <button type="button" id="go-manual" class="btn-linklike">Enter it manually →</button>
      &nbsp;·&nbsp;
      <button type="button" id="go-import" class="btn-linklike">Import from Goodreads →</button>
    </p>`;
  panel.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => hideModal('#add-modal')));
  $('#go-manual').addEventListener('click', showManualForm);
  $('#go-import').addEventListener('click', showImportFlow);
  setupAddFlow();
  showModal('#add-modal');
}

function showManualForm() {
  const panel = $('#add-modal .modal-panel');
  panel.innerHTML = `<button class="modal-close" data-close aria-label="Close">×</button>
    <h2>Add manually</h2>
    <p class="modal-subtitle">Fill in whatever you know. Only the title is required.</p>
    <form id="manual-book-form">
      <label>Title *
        <input type="text" name="title" required autofocus>
      </label>
      <label>Subtitle
        <input type="text" name="subtitle">
      </label>
      <label>Author(s) <span style="font-weight:400;color:var(--ink-muted);font-size:12px;">— comma-separated for multiple</span>
        <input type="text" name="authors" placeholder="e.g. George Eliot">
      </label>
      <div class="form-row">
        <label>Year published
          <input type="number" name="year_published" placeholder="e.g. 1872">
        </label>
        <label>Page count
          <input type="number" name="page_count" min="0">
        </label>
      </div>
      <label>Publisher
        <input type="text" name="publisher">
      </label>
      <label>ISBN
        <input type="text" name="isbn">
      </label>
      <label>Cover image URL <span style="font-weight:400;color:var(--ink-muted);font-size:12px;">— right-click a cover anywhere, copy image address, paste here</span>
        <input type="url" name="cover_url" placeholder="https://...">
      </label>
      <div class="form-row">
        <label>Status
          <select name="status">
            <option value="want_to_read" selected>Want to read</option>
            <option value="reading">Reading</option>
            <option value="finished">Finished</option>
          </select>
        </label>
        <label>Fiction / non-fiction
          <select name="is_fiction">
            <option value="" selected>—</option>
            <option value="true">Fiction</option>
            <option value="false">Non-fiction</option>
          </select>
        </label>
      </div>
      <label>Tags (comma-separated)
        <input type="text" name="genres" placeholder="e.g. Fantasy, Memoir">
      </label>
      <div id="manual-error" class="form-error" hidden></div>
      <div style="display:flex; gap:8px; margin-top:16px;">
        <button type="submit" class="btn btn-primary">Add to library</button>
        <button type="button" class="btn btn-ghost" id="back-to-search-2">← Back to search</button>
      </div>
    </form>`;
  panel.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => hideModal('#add-modal')));
  $('#back-to-search-2').addEventListener('click', () => openAddModal());
  $('#manual-book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const newBook = {
      title: (data.get('title') || '').trim() || 'Untitled',
      subtitle: data.get('subtitle') || null,
      authors: (data.get('authors') || '').split(',').map((s) => s.trim()).filter(Boolean),
      publisher: data.get('publisher') || null,
      year_published: data.get('year_published') ? Number(data.get('year_published')) : null,
      page_count: data.get('page_count') ? Number(data.get('page_count')) : null,
      isbn: data.get('isbn') || null,
      cover_url: data.get('cover_url') || null,
      status: data.get('status'),
      is_fiction: data.get('is_fiction') === '' ? null : data.get('is_fiction') === 'true',
      genres: (data.get('genres') || '').split(',').map((s) => s.trim()).filter(Boolean),
      subjects: [],
      current_page: 0,
    };
    try {
      const saved = await upsertBook(newBook);
      state.books.unshift(saved);
      hideModal('#add-modal');
      render();
    } catch (err) {
      const e = $('#manual-error');
      e.textContent = err.message;
      e.hidden = false;
    }
  });
}

function setupAddFlow() {
  $('#ol-search-btn').addEventListener('click', doOlSearch);
  $('#ol-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doOlSearch(); }
  });
  $('#ol-search').addEventListener('input', () => {
    clearTimeout(olSearchTimer);
    olSearchTimer = setTimeout(doOlSearch, 400);
  });
}

async function doOlSearch() {
  const q = $('#ol-search').value.trim();
  const results = $('#ol-results');
  if (!q) { results.innerHTML = ''; return; }
  results.innerHTML = '<div class="state-message">Searching Open Library…</div>';
  try {
    const docs = await olSearch(q);
    if (docs.length === 0) { results.innerHTML = '<div class="state-message">No results.</div>'; return; }
    results.innerHTML = docs.map((d, i) => {
      const cover = COVER(d.cover_i, 'S');
      const authors = (d.author_name || []).slice(0, 3).join(', ');
      return `<button class="ol-result" data-idx="${i}">
        <div class="ol-result-cover">${cover ? `<img src="${escape(cover)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}</div>
        <div class="ol-result-info">
          <div class="ol-result-title">${escape(d.title)}${d.subtitle ? `: ${escape(d.subtitle)}` : ''}</div>
          <div class="ol-result-meta">${escape(authors) || 'Unknown author'}${d.first_publish_year ? ` · ${d.first_publish_year}` : ''}</div>
        </div>
      </button>`;
    }).join('');
    $$('#ol-results .ol-result').forEach((el) => {
      el.addEventListener('click', () => {
        const doc = docs[Number(el.dataset.idx)];
        showNewBookForm(olToBook(doc));
      });
    });
  } catch (err) {
    results.innerHTML = `<div class="form-error">${escape(err.message)}</div>`;
  }
}

function showNewBookForm(prefilled) {
  const panel = $('#add-modal .modal-panel');
  panel.innerHTML = `<button class="modal-close" data-close aria-label="Close">×</button>
    <h2>Add to library</h2>
    <p class="modal-subtitle">${escape(prefilled.title)}${prefilled.authors[0] ? ` — ${escape(prefilled.authors[0])}` : ''}</p>
    <form id="new-book-form">
      <div class="form-row">
        <label>Status
          <select name="status">
            <option value="want_to_read" selected>Future reading</option>
            <option value="reading">Reading</option>
            <option value="finished">Finished</option>
          </select>
        </label>
        <label>Fiction / non-fiction
          <select name="is_fiction">
            <option value="" ${prefilled.is_fiction == null ? 'selected' : ''}>—</option>
            <option value="true" ${prefilled.is_fiction === true ? 'selected' : ''}>Fiction</option>
            <option value="false" ${prefilled.is_fiction === false ? 'selected' : ''}>Non-fiction</option>
          </select>
        </label>
      </div>
      <label>Tags (comma-separated, edit as you like)
        <input type="text" name="genres" value="${escape((prefilled.genres || []).join(', '))}">
      </label>
      <div id="new-error" class="form-error" hidden></div>
      <div style="display:flex; gap:8px; margin-top:16px;">
        <button type="submit" class="btn btn-primary">Add to library</button>
        <button type="button" class="btn btn-ghost" id="back-to-search">← Back to search</button>
      </div>
    </form>`;
  $('#back-to-search').addEventListener('click', () => openAddModal());
  panel.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => hideModal('#add-modal')));
  $('#new-book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const newBook = {
      ...prefilled,
      status: data.get('status'),
      is_fiction: data.get('is_fiction') === '' ? null : data.get('is_fiction') === 'true',
      genres: (data.get('genres') || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      const saved = await upsertBook(newBook);
      state.books.unshift(saved);
      hideModal('#add-modal');
      render();
    } catch (err) {
      const e = $('#new-error');
      e.textContent = err.message;
      e.hidden = false;
    }
  });
}

/* ===================== Goodreads CSV import ===================== */

function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
}

function transformGoodreadsRow(r) {
  const stripIsbn = (s) => (s || '').replace(/[="]/g, '').trim();
  const isbn = stripIsbn(r['ISBN13']) || stripIsbn(r['ISBN']);
  const flipName = (s) => {
    if (!s) return s;
    const m = s.match(/^([^,]+),\s*(.+)$/);
    if (m && m[2].trim()) return `${m[2].trim()} ${m[1].trim()}`;
    return s.replace(/,\s*$/, '').trim();
  };
  const mainAuthor = flipName(r['Author l-f'] || r['Author']);
  const additional = (r['Additional Authors'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const authors = [mainAuthor, ...additional].filter(Boolean);

  const shelf = (r['Exclusive Shelf'] || '').trim();
  const status = shelf === 'read' ? 'finished'
               : shelf === 'currently-reading' ? 'reading'
               : 'want_to_read';

  const fmtDate = (d) => d ? d.replace(/\//g, '-') : null;
  const year = parseInt(r['Original Publication Year'] || r['Year Published'] || '', 10);
  const pages = parseInt(r['Number of Pages'] || '', 10);
  const rating = parseInt(r['My Rating'] || '', 10);

  const allShelves = (r['Bookshelves'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tags = allShelves.filter((s) => !['read', 'currently-reading', 'to-read', 'currently_reading', 'to_read'].includes(s));

  const review = (r['My Review'] || '').trim();
  const privateNotes = (r['Private Notes'] || '').trim();
  const notes = [review, privateNotes].filter(Boolean).join('\n\n') || null;

  return {
    title: (r['Title'] || '').trim() || 'Untitled',
    authors,
    isbn: isbn || null,
    publisher: r['Publisher']?.trim() || null,
    year_published: Number.isFinite(year) ? year : null,
    page_count: Number.isFinite(pages) && pages > 0 ? pages : null,
    rating: rating > 0 && rating <= 5 ? rating : null,
    status,
    date_finished: status === 'finished' ? fmtDate(r['Date Read']) : null,
    date_started: null,
    notes,
    genres: tags,
    cover_url: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false` : null,
    subjects: [],
    current_page: status === 'finished' && Number.isFinite(pages) ? pages : 0,
    is_fiction: null,
  };
}

function showImportFlow() {
  const panel = $('#add-modal .modal-panel');
  panel.innerHTML = `<button class="modal-close" data-close aria-label="Close">×</button>
    <h2>Import from Goodreads</h2>
    <p class="modal-subtitle">
      In Goodreads: <strong>Settings → Profile → Goodreads Library Export</strong> → click <em>Export Library</em>, wait a moment, then download the CSV. Drop it here.
    </p>
    <label style="display:block;border:2px dashed var(--rule-strong);border-radius:var(--radius);padding:24px;text-align:center;cursor:pointer;background:var(--bg-soft);">
      <input type="file" id="goodreads-file" accept=".csv,text/csv" style="display:none;">
      <span style="color:var(--ink-soft);font-family:var(--serif);font-style:italic;font-size:16px;">Click to choose your <code>goodreads_library_export.csv</code></span>
    </label>
    <div id="import-error" class="form-error" hidden></div>
    <div id="import-summary" style="margin-top:16px;"></div>
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button type="button" class="btn btn-ghost" id="import-back">← Back</button>
    </div>`;
  panel.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => hideModal('#add-modal')));
  $('#import-back').addEventListener('click', () => openAddModal());
  $('#goodreads-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await handleImportFile(file);
  });
}

async function handleImportFile(file) {
  const summaryEl = $('#import-summary');
  const errEl = $('#import-error');
  errEl.hidden = true;
  summaryEl.innerHTML = '<div style="color:var(--ink-muted);font-style:italic;">Parsing…</div>';

  let rows;
  try {
    const text = await file.text();
    rows = parseCSV(text);
  } catch (err) {
    errEl.textContent = 'Could not read the file. Make sure it’s a CSV.';
    errEl.hidden = false;
    summaryEl.innerHTML = '';
    return;
  }

  if (rows.length === 0 || !rows[0]['Title']) {
    errEl.textContent = 'This doesn’t look like a Goodreads export. Expected a column called "Title".';
    errEl.hidden = false;
    summaryEl.innerHTML = '';
    return;
  }

  const parsed = rows.map(transformGoodreadsRow).filter((b) => b.title);

  // Dedup against existing library
  const existingISBNs = new Set(state.books.filter((b) => b.isbn).map((b) => b.isbn));
  const existingKeys = new Set(state.books.map((b) => `${(b.title || '').toLowerCase()}|${((b.authors || [])[0] || '').toLowerCase()}`));

  const toImport = [];
  let dupSkipped = 0;
  for (const b of parsed) {
    if (b.isbn && existingISBNs.has(b.isbn)) { dupSkipped++; continue; }
    const key = `${b.title.toLowerCase()}|${((b.authors || [])[0] || '').toLowerCase()}`;
    if (existingKeys.has(key)) { dupSkipped++; continue; }
    toImport.push(b);
    if (b.isbn) existingISBNs.add(b.isbn);
    existingKeys.add(key);
  }

  const byStatus = { finished: 0, reading: 0, want_to_read: 0 };
  for (const b of toImport) byStatus[b.status]++;

  summaryEl.innerHTML = `
    <div style="background:var(--bg-soft);border:1px solid var(--rule);border-radius:var(--radius);padding:16px;margin-bottom:12px;">
      <div style="font-family:var(--serif);font-size:18px;margin-bottom:8px;">Found <strong>${parsed.length}</strong> books in your CSV.</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;color:var(--ink-soft);">
        <li><strong>${toImport.length}</strong> new — will be added (${byStatus.finished} finished, ${byStatus.reading} reading, ${byStatus.want_to_read} future)</li>
        <li><strong>${dupSkipped}</strong> already in your library — will be skipped</li>
      </ul>
    </div>
    <button type="button" class="btn btn-primary" id="confirm-import" ${toImport.length === 0 ? 'disabled' : ''}>
      ${toImport.length === 0 ? 'Nothing to import' : `Import ${toImport.length} books`}
    </button>`;

  if (toImport.length > 0) {
    $('#confirm-import').addEventListener('click', () => runImport(toImport));
  }
}

async function runImport(toImport) {
  const summaryEl = $('#import-summary');
  const total = toImport.length;
  const CHUNK = 100;
  let done = 0;
  let failed = 0;
  const inserted = [];

  summaryEl.innerHTML = `
    <div style="margin-bottom:12px;font-family:var(--serif);font-size:16px;">Importing… <span id="import-progress-text">0 / ${total}</span></div>
    <div style="height:8px;background:var(--rule);border-radius:99px;overflow:hidden;">
      <div id="import-progress-bar" style="width:0%;height:100%;background:var(--ink);transition:width 200ms ease;"></div>
    </div>`;

  for (let i = 0; i < total; i += CHUNK) {
    const chunk = toImport.slice(i, i + CHUNK);
    try {
      const { data, error } = await sb.from('books').insert(chunk).select();
      if (error) throw error;
      if (data) inserted.push(...data);
    } catch (err) {
      failed += chunk.length;
      console.error('Chunk failed:', err);
    }
    done += chunk.length;
    $('#import-progress-text').textContent = `${Math.min(done, total)} / ${total}`;
    $('#import-progress-bar').style.width = `${(done / total) * 100}%`;
  }

  // Add the inserted books to local state and re-render
  state.books = [...inserted, ...state.books];
  render();

  summaryEl.innerHTML = `
    <div style="background:var(--bg-soft);border:1px solid var(--rule);border-radius:var(--radius);padding:16px;">
      <div style="font-family:var(--serif);font-size:20px;margin-bottom:6px;">Done.</div>
      <div style="font-size:14px;color:var(--ink-soft);">
        Imported <strong>${inserted.length}</strong> books.
        ${failed > 0 ? `<br><span style="color:var(--accent);">${failed} failed — check the browser console.</span>` : ''}
      </div>
    </div>
    <button type="button" class="btn btn-primary" id="import-done" style="margin-top:12px;">Done</button>`;
  $('#import-done').addEventListener('click', () => hideModal('#add-modal'));
}

/* ===================== Bulk selection ===================== */

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  if (!state.selectMode) state.selected.clear();
  $('#select-btn').textContent = state.selectMode ? 'Cancel' : 'Select';
  updateSelectionBar();
  render();
}

function updateSelectionBar() {
  let bar = $('#selection-bar');
  if (!state.selectMode) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selection-bar';
    bar.className = 'selection-bar';
    const content = $('#content');
    content.parentNode.insertBefore(bar, content);
  }
  const n = state.selected.size;
  bar.innerHTML = `
    <div class="selection-bar-inner">
      <span><strong>${n}</strong> selected</span>
      <button class="btn btn-ghost btn-small" id="sel-all">Select all visible</button>
      <button class="btn btn-ghost btn-small" id="sel-clear" ${n === 0 ? 'disabled' : ''}>Clear</button>
      <button class="btn btn-danger btn-small" id="sel-delete" ${n === 0 ? 'disabled' : ''}>Delete ${n || ''}</button>
    </div>`;
  $('#sel-all').addEventListener('click', () => {
    for (const b of visibleBooks()) state.selected.add(b.id);
    updateSelectionBar();
    render();
  });
  $('#sel-clear').addEventListener('click', () => {
    state.selected.clear();
    updateSelectionBar();
    render();
  });
  $('#sel-delete').addEventListener('click', bulkDelete);
}

async function bulkDelete() {
  const ids = [...state.selected];
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} book${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const { error } = await sb.from('books').delete().in('id', ids);
  if (error) { alert('Delete failed: ' + error.message); return; }
  const idSet = new Set(ids);
  state.books = state.books.filter((b) => !idSet.has(b.id));
  state.selected.clear();
  state.selectMode = false;
  $('#select-btn').textContent = 'Select';
  updateSelectionBar();
  render();
}

/* ===================== Auth ===================== */

function updateAuthUI() {
  if (state.user) {
    $('#auth-btn').textContent = 'Sign out';
    $('#add-btn').hidden = false;
    $('#select-btn').hidden = false;
  } else {
    $('#auth-btn').textContent = 'Sign in';
    $('#add-btn').hidden = true;
    $('#select-btn').hidden = true;
    if (state.selectMode) {
      state.selectMode = false;
      state.selected.clear();
      updateSelectionBar();
    }
  }
}

function setupAuth() {
  $('#auth-btn').addEventListener('click', async () => {
    if (state.user) {
      await sb.auth.signOut();
    } else {
      $('#auth-email').value = '';
      $('#auth-password').value = '';
      $('#auth-error').hidden = true;
      showModal('#auth-modal');
      $('#auth-email').focus();
    }
  });
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value;
    const password = $('#auth-password').value;
    const errEl = $('#auth-error');
    errEl.hidden = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { errEl.textContent = error.message; errEl.hidden = false; return; }
    hideModal('#auth-modal');
  });
  sb.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    updateAuthUI();
    render();
  });
}

/* ===================== Modal helpers ===================== */

function showModal(sel) {
  const el = $(sel);
  el.hidden = false;
  if (window.parent !== window) {
    el.classList.add('modal-anchored');
    window.parent.postMessage({ type: 'book-tracker-focus' }, '*');
  }
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', escClose);
}
function hideModal(sel) {
  const el = $(sel);
  el.hidden = true;
  el.classList.remove('modal-anchored');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) {
  if (e.key === 'Escape') {
    $$('.modal').forEach((m) => { if (!m.hidden) hideModal('#' + m.id); });
  }
}

/* ===================== Wire-up ===================== */

function setupEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      state.tab = tab.dataset.tab;
      // Filters only meaningfully apply to the Full List tab
      $('#toolbar').hidden = state.tab !== 'full';
      render();
    });
  });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#filter-author').addEventListener('change', (e) => { state.filters.author = e.target.value; render(); });
  $('#filter-year-read').addEventListener('change', (e) => { state.filters.yearRead = e.target.value; render(); });
  $('#filter-year-published').addEventListener('change', (e) => { state.filters.yearPublished = e.target.value; render(); });
  $('#filter-fiction').addEventListener('change', (e) => { state.filters.fiction = e.target.value; render(); });
  $('#filter-genre').addEventListener('change', (e) => { state.filters.genre = e.target.value; render(); });
  $('#clear-filters').addEventListener('click', () => {
    state.filters = { author: '', yearRead: '', yearPublished: '', fiction: '', genre: '' };
    state.search = '';
    $('#search').value = '';
    render();
  });
  $('#add-btn').addEventListener('click', openAddModal);
  $('#select-btn').addEventListener('click', toggleSelectMode);
  $$('[data-close]').forEach((el) => el.addEventListener('click', () => {
    const m = el.closest('.modal');
    if (m) hideModal('#' + m.id);
  }));
}

function setupIframeAutoResize() {
  if (window.parent === window) return;
  const post = () => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    window.parent.postMessage({ type: 'book-tracker-height', height: h }, '*');
  };
  new ResizeObserver(post).observe(document.body);
  window.addEventListener('load', post);
}

async function init() {
  setupHero();
  setupEvents();
  setupAuth();
  setupIframeAutoResize();
  const { data: { session } } = await sb.auth.getSession();
  state.user = session?.user || null;
  updateAuthUI();
  state.books = await fetchBooks();
  render();
}

init();
