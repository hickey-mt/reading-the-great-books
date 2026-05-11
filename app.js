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
    // Cover-grid tabs: sort by date_finished desc for completed, by date_started desc for reading, by created_at desc for want
    return [...books].sort((a, b) => {
      if (state.tab === 'completed') return (b.date_finished || '').localeCompare(a.date_finished || '');
      if (state.tab === 'reading') return (b.date_started || '').localeCompare(a.date_started || '');
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
    el.addEventListener('click', () => openBookDetail(el.dataset.id));
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
    return `<tr class="book-row" data-id="${b.id}">
      <td class="col-number">${i + 1}</td>
      <td class="col-author">${escape(authors)}</td>
      <td class="col-title">${escape(b.title)}${b.subtitle ? `<span class="book-subtitle">${escape(b.subtitle)}</span>` : ''}</td>
      <td class="col-year">${b.year_published ?? ''}</td>
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
  return `<button class="cover-tile" data-id="${b.id}">
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
  fillSelect('#filter-genre', [...genres].sort(), state.filters.genre, 'All genres');
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
    <label>Genres (comma-separated)
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
    <div id="ol-results" class="ol-results"></div>`;
  panel.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => hideModal('#add-modal')));
  setupAddFlow();
  showModal('#add-modal');
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
      <label>Genres (comma-separated, edit as you like)
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

/* ===================== Auth ===================== */

function updateAuthUI() {
  if (state.user) {
    $('#auth-btn').textContent = 'Sign out';
    $('#add-btn').hidden = false;
  } else {
    $('#auth-btn').textContent = 'Sign in';
    $('#add-btn').hidden = true;
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
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', escClose);
}
function hideModal(sel) {
  const el = $(sel);
  el.hidden = true;
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
  $$('[data-close]').forEach((el) => el.addEventListener('click', () => {
    const m = el.closest('.modal');
    if (m) hideModal('#' + m.id);
  }));
}

async function init() {
  setupHero();
  setupEvents();
  setupAuth();
  const { data: { session } } = await sb.auth.getSession();
  state.user = session?.user || null;
  updateAuthUI();
  state.books = await fetchBooks();
  render();
}

init();
