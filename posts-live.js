// posts-live.js  (save in the SAME folder as app.html)
// Stores posts, photos, likes and comments in Supabase. Only runs when backend.js is in live mode.
(function () {
  'use strict';
  var B = window.EMEMART_BACKEND;
  if (!B || B.mode !== 'live' || !window.sb) return;
  var sb = window.sb;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s)); }
  function me() { return typeof state !== 'undefined' && state.session ? state.session : null; }
  function toast(i, t, m) { try { showPopupNotif(i, t, m); } catch (e) {} }

  // ---- upload a photo: shrink it, then send it to Cloudinary (falls back to Supabase storage) ----
  function shrink(dataUrl, maxSide, quality) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, maxSide / Math.max(w, h));
        var cv = document.createElement('canvas'); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality);
      };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }
  async function uploadToCloudinary(blob) {
    var t = await window.callApi('POST', '/media/sign', {});
    if (!t || !t.public_id) throw new Error((t && t.message) || 'Could not start the upload');
    var fd = new FormData();
    fd.append('file', blob); fd.append('api_key', t.api_key); fd.append('timestamp', t.timestamp);
    fd.append('public_id', t.public_id); fd.append('signature', t.signature);
    var r = await fetch('https://api.cloudinary.com/v1_1/' + t.cloud_name + '/image/upload', { method: 'POST', body: fd });
    var j = await r.json();
    if (!r.ok || !j.secure_url) throw new Error((j.error && j.error.message) || 'Photo upload failed');
    // ask Cloudinary for a lighter copy: best format for the phone, auto quality, max 1200px wide
    var url = j.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_1200,c_limit/');
    return { url: url, path: 'cld:' + j.public_id };
  }
  async function uploadImage(dataUrl, userId) {
    if (!/^data:image\//.test(dataUrl)) return { url: dataUrl, path: null };   // already a normal URL
    var blob = (await shrink(dataUrl, 1600, 0.82)) || (await (await fetch(dataUrl)).blob());
    try {
      return await uploadToCloudinary(blob);
    } catch (e) {
      console.warn('Cloudinary upload failed, using Supabase storage instead:', e && e.message);
    }
    var ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
    var path = userId + '/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
    var up = await sb.storage.from('post-images').upload(path, blob, { contentType: blob.type, upsert: false });
    if (up.error) throw up.error;
    return { url: sb.storage.from('post-images').getPublicUrl(path).data.publicUrl, path: path };
  }

  // ---- server row  ->  the post object the app already understands -------------------------
  function toPost(row, prof, likes, comments, names) {
    var x = row.extra || {};
    var p = Object.assign({}, x);
    p.id = row.id;
    p.authorId = row.author_id;
    p.authorName = esc(prof ? prof.full_name : 'Ememart user');
    p.authorRole = prof ? (prof.role === 'user' ? 'buyer' : prof.role) : p.authorRole;
    p.authorVerified = !!(prof && prof.verified);
    p.location = esc(row.area || p.location || '');
    p.text = esc(row.type === 'food' || row.type === 'booking' ? (x.text || '') : (row.description || x.text || ''));
    p.ts = new Date(row.created_at).getTime();
    p.images = row.images || [];
    p.image = p.images[0] || null;
    p.likes = likes || [];
    p.comments = (comments || []).map(function (c) {
      return { author: esc(names[c.user_id] || 'User'), text: esc(c.body), ts: new Date(c.created_at).getTime() };
    });
    p.reactions = p.reactions || {};
    p.retention = row.retention === 'open' ? 'open' : (row.type === 'booking' ? 'booking' : 'delete_24h');
    p.expiresAt = row.closes_at ? new Date(row.closes_at).getTime() : (row.expires_at ? new Date(row.expires_at).getTime() : null);   // closes to orders
    p.removeAt = row.expires_at ? new Date(row.expires_at).getTime() : null;                                                        // removed from the app
    p.deleteAt = new Date(row.delete_at).getTime();
    if (row.type === 'booking') { p.isBooking = true; p.bookingMeta = row.booking_meta || p.bookingMeta; }
    if (row.promoted_until) p.boostedUntil = new Date(row.promoted_until).getTime();
    ['foodName', 'foodExtras', 'foodCategory', 'bizServiceName', 'bizAvail'].forEach(function (k) { if (p[k]) p[k] = esc(p[k]); });
    return p;
  }

  // ---- load the whole feed -----------------------------------------------------------------
  var loading = false;
  async function loadPosts() {
    if (loading) return; loading = true;
    try {
      var r = await sb.from('posts').select('*').order('created_at', { ascending: false }).limit(300);
      if (r.error) throw r.error;
      var rows = r.data || [];
      var ids = rows.map(function (x) { return x.id; });
      var authors = Array.from(new Set(rows.map(function (x) { return x.author_id; })));
      var profs = {}, likes = {}, cmts = {}, names = {};
      if (authors.length) {
        var pr = await sb.from('public_profiles').select('*').in('id', authors);
        (pr.data || []).forEach(function (p) { profs[p.id] = p; names[p.id] = p.full_name; });
      }
      if (ids.length) {
        var lk = await sb.from('post_likes').select('post_id,user_id').in('post_id', ids);
        (lk.data || []).forEach(function (l) { (likes[l.post_id] = likes[l.post_id] || []).push(l.user_id); });
        var cm = await sb.from('post_comments').select('*').in('post_id', ids).order('created_at');
        (cm.data || []).forEach(function (c) { (cmts[c.post_id] = cmts[c.post_id] || []).push(c); });
        var cu = Array.from(new Set((cm.data || []).map(function (c) { return c.user_id; }).filter(function (u) { return !names[u]; })));
        if (cu.length) {
          var cp = await sb.from('public_profiles').select('id,full_name').in('id', cu);
          (cp.data || []).forEach(function (p) { names[p.id] = p.full_name; });
        }
      }
      state.posts = rows.map(function (row) { return toPost(row, profs[row.author_id], likes[row.id], cmts[row.id], names); });
      try { localStorage.removeItem('ememart_posts'); } catch (e) {}
      renderFeed();
    } catch (e) {
      console.warn('posts-live: load failed', e);
    } finally { loading = false; }
  }
  B.reloadPosts = loadPosts;

  // ---- publish -----------------------------------------------------------------------------
  var _submit = window.submitPost;
  window.submitPost = function () {
    var before = state.posts.length;
    var self = this, args = arguments;
    Promise.resolve(_submit.apply(self, args)).then(function () {   // validation + form reset (the old local publish)
      if (state.posts.length <= before) return;           // validation failed
      var local = state.posts[0];
      state.posts.shift();                                // remove the local-only copy
      try { localStorage.removeItem('ememart_posts'); } catch (e) {}
      publish(local);
    });
  };

  async function publish(p) {
    var u = me(); if (!u) return;
    try {
      var urls = [], paths = [];
      var imgs = (p.images && p.images.length ? p.images : (p.image ? [p.image] : []));
      for (var i = 0; i < imgs.length; i++) {
        var up = await uploadImage(imgs[i], u.id);
        urls.push(up.url); if (up.path) paths.push(up.path);
      }
      var type = p.isBooking ? 'booking' : p.isFood ? 'food' : (p.bizType ? 'service' : 'regular');
      var title = p.foodName || p.bizServiceName || (p.text || '').slice(0, 80) || 'Post';
      var price = p.isFood ? p.price : (p.bizPrice || null);
      var extra = Object.assign({}, p);
      ['id', 'authorId', 'authorName', 'ts', 'image', 'images', 'likes', 'comments', 'expiresAt', 'deleteAt', 'openSince', 'nextReminderAt', 'reminderStage', 'expired', 'boostedUntil'].forEach(function (k) { delete extra[k]; });
      var row = {
        author_id: u.id, type: type, title: title, description: p.text || null,
        price_kobo: price ? Math.round(price * 100) : null,
        category: p.foodCategory || p.bizType || null,
        area: p.location || null,
        images: urls, image_paths: paths,
        retention: p.retention === 'open' ? 'open' : 'delete_24h',
        booking_meta: p.isBooking ? (p.bookingMeta || null) : null,
        extra: extra,
      };
      var ins = await sb.from('posts').insert(row);
      if (ins.error) throw ins.error;
      toast('🎉', 'Published!', 'Your post is now live.');
      await loadPosts();
    } catch (e) {
      console.warn('posts-live: publish failed', e);
      toast('❌', 'Post not published', (e && e.message) || 'Please try again.');
    }
  }

  // ---- delete ------------------------------------------------------------------------------
  window.deletePost = async function (postId) {
    var u = me(); if (!u) { toast('🔐', 'Sign In', 'Please sign in first.'); return; }
    var post = state.posts.find(function (p) { return p.id === postId; });
    if (!post) { toast('❌', 'Not Found', 'Post not found.'); return; }
    if (post.authorId !== u.id) { toast('❌', 'Permission Denied', 'You can only delete your own posts.'); return; }
    if (!(await uiConfirm('Delete this post permanently?'))) return;
    var d = await sb.from('posts').delete().eq('id', postId);
    if (d.error) { toast('❌', 'Not deleted', d.error.message); return; }
    toast('🗑️', 'Deleted', 'Post has been removed.');
    loadPosts();
  };

  // ---- edit (text, name, price, availability of your own post) ------------------------------
  window.persistPostEdit = async function (post, changes) {
    var u = me(); if (!u) throw new Error('Please sign in first.');
    if (post.authorId !== u.id) throw new Error('You can only edit your own posts.');
    var cur = await sb.from('posts').select('extra').eq('id', post.id).single();
    if (cur.error) throw cur.error;
    var extra = Object.assign({}, cur.data.extra || {}, changes);
    var upd = { extra: extra };
    var title = changes.foodName || changes.bizServiceName;
    if (title) upd.title = title;
    var price = changes.price != null ? changes.price : changes.bizPrice;
    if (price != null) upd.price_kobo = Math.round(price * 100);
    if (changes.text != null) upd.description = changes.text;
    if (!post.isFood && !post.bizType) upd.title = (changes.text || '').slice(0, 80) || 'Post';
    var r = await sb.from('posts').update(upd).eq('id', post.id);
    if (r.error) throw r.error;
    Object.assign(post, changes);
    loadPosts();
  };

  // ---- likes -------------------------------------------------------------------------------
  window.likePost = async function (id) {
    var u = me(); if (!u) { toast('🔐', 'Sign in Required', 'Please sign in to like posts.'); return; }
    var post = state.posts.find(function (p) { return p.id === id; });
    if (!post || !isUuid(id)) return;
    var liked = post.likes.indexOf(u.id) >= 0;
    // update the screen first, then the server; undo if the server says no
    post.likes = liked ? post.likes.filter(function (x) { return x !== u.id; }) : post.likes.concat([u.id]);
    renderFeed();
    var r = liked ? await sb.from('post_likes').delete().eq('post_id', id).eq('user_id', u.id)
                  : await sb.from('post_likes').insert({ post_id: id, user_id: u.id });
    if (r.error) {
      post.likes = liked ? post.likes.concat([u.id]) : post.likes.filter(function (x) { return x !== u.id; });
      renderFeed();
    }
  };

  // ---- comments ----------------------------------------------------------------------------
  window.submitComment = async function () {
    var u = me(); if (!u) { toast('🔐', 'Sign In', 'Please sign in to comment.'); return; }
    var inp = document.getElementById('comment-inp');
    var val = inp ? inp.value.trim() : '';
    if (!val) return;
    var id = (typeof activeCommentPostId !== 'undefined') ? activeCommentPostId : null;
    var post = state.posts.find(function (p) { return p.id === id; });
    if (!post || !isUuid(id)) return;
    inp.value = '';
    var r = await sb.from('post_comments').insert({ post_id: id, user_id: u.id, body: val.slice(0, 1000) });
    if (r.error) { toast('❌', 'Comment not sent', r.error.message); inp.value = val; return; }
    post.comments.push({ author: esc((u.name || 'You').split(' ')[0]), text: esc(val), ts: Date.now() });
    try { openCommentsModal(id); } catch (e) {}
    renderFeed();
  };

  // ---- first load + refresh every 60 seconds and when the tab is opened again --------------
  window.addEventListener('load', function () { setTimeout(loadPosts, 400); });
  setInterval(function () { if (!document.hidden) loadPosts(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadPosts(); });
})();
