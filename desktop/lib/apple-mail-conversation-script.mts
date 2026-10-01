// Runs inside the existing JXA request, with the same mailbox resolution and error boundary.
export const MAIL_CONVERSATION_SCRIPT = String.raw`
function conversation(target) {
  var incomplete = false, started = Date.now();
  var members = [], known = Object.create(null), seen = Object.create(null), copies = Object.create(null);
  var frontier = [], folders = [], visited = Object.create(null);
  function identity(value) {
    return string(value).trim().replace(/^<|>$/g, '');
  }
  function links(message) {
    var raw = string(message.allHeaders());
    if (raw.length > 262144) { incomplete = true; raw = raw.slice(0, 262144); }
    var headers = raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
    var ids = [], own = identity(message.messageId());
    if (own) ids.push(own);
    headers.forEach(function(line) {
      if (!/^(message-id|in-reply-to|references):/i.test(line)) return;
      var matches = line.match(/<[^<>\s]+>/g) || [];
      if (!own && /^message-id:/i.test(line) && matches.length) own = identity(matches[0]);
      matches.forEach(function(value) { var id = identity(value); if (ids.indexOf(id) < 0) ids.push(id); });
    });
    return { own: own, ids: ids };
  }
  function remember(message, ref, first) {
    var localId = message.id(), key = JSON.stringify([ref, localId]);
    if (seen[key]) return;
    var relation = links(message);
    if (!first && !relation.ids.some(function(id) { return known[id]; })) return;
    seen[key] = true;
    relation.ids.forEach(function(id) {
      if (known[id]) return;
      if (Object.keys(known).length >= 200 || id.length > 998) { incomplete = true; return; }
      known[id] = true; frontier.push(id);
    });
    if (relation.own && copies[relation.own]) return;
    if (members.length >= CONVERSATION_LIMIT) { incomplete = true; return; }
    if (relation.own) copies[relation.own] = true;
    members.push({ target: {mailbox: ref, id: localId}, summary: summary(message) });
  }
  remember(selectedMessage(target), target.mailbox, true);
  function walk(boxes, parent) {
    for (var index = 0; index < boxes.length; index++) {
      if (folders.length >= 5000 || parent.length >= 32) { incomplete = true; return; }
      var box = boxes[index], path = parent.concat([box.name()]), key = JSON.stringify(path);
      if (visited[key]) continue;
      visited[key] = true;
      folders.push({box: box, ref: {accountId: target.mailbox.accountId, path: path}});
      walk(box.mailboxes, path);
    }
  }
  if (frontier.length) walk(target.mailbox.accountId === null ? app.mailboxes : app.accounts.byId(target.mailbox.accountId).mailboxes, []);
  // Search headers, never message bodies or subject-only matches. Include Sent and
  // nested folders in the same account; follow ancestors as well as descendants.
  while (frontier.length && members.length < CONVERSATION_LIMIT) {
    var batch = frontier.splice(0, 20);
    var predicates = [];
    batch.forEach(function(id) {
      predicates.push({messageId: id}, {messageId: '<' + id + '>'}, {allHeaders: {_contains: id}});
    });
    for (var index = 0; index < folders.length; index++) {
      if (Date.now() - started > 60000) { incomplete = true; frontier = []; break; }
      var folder = folders[index];
      try {
        var matches = folder.box.messages.whose({_or: predicates})();
        if (matches.length > 500) incomplete = true;
        for (var match = 0; match < Math.min(matches.length, 500); match++) remember(matches[match], folder.ref, false);
      } catch (error) {
        if (Number(error.errorNumber || error.number || 0) === -1743) throw error;
        incomplete = true;
      }
    }
  }
  if (frontier.length) incomplete = true;
  members.sort(function(a, b) {
    var left = a.summary.date ? Date.parse(a.summary.date) : Infinity;
    var right = b.summary.date ? Date.parse(b.summary.date) : Infinity;
    return left === right ? a.summary.id - b.summary.id : left < right ? -1 : 1;
  });
  return {messages: members, incomplete: incomplete};
}
`;
