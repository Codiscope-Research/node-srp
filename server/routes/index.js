const crypto = require('crypto'),
      bigint = require('bigint'),
      config = require('../../lib/config'),
      params = require('../../lib/params'),
      S_BYTES = config.get('s_bytes'),
      db = require('../../lib/db'),
      srp = require('../../lib/srp');

var sessions = {};

function generateSessionId(callback) {
  srp.genKey(32, function(err, key) {
    if (err) return callback(err);
    return callback(null, key.toString(60));
  });
}

/*
 * GET home page.
 */

exports.index = function(req, res){
  res.render('index', { title: 'Express' });
};

/*
 * API methods.  All POST.
 */

/*
 * Create a new account on the server, storing identity, salt, and verifier.
 *
 * Required params:
 *     identity (string)          the user's identity
 *     salt (string)              unique salt
 *     verifier (string)          hex-encoded verifier
 *
 * returns: 200 OK on success
 */
exports.create = function(req, res) {
  var I = req.body.identity;
  var v = bigint(req.body.verifier, 16);
  var s = req.body.salt;
  var N_bits = req.body.N_bits;
  var alg = req.body.alg_name;
  if (! (I && v && s && N_bits && alg)) {
    return res.json(400);
  }

  db.fetch(I, function(err, data) {
    // account exists?
    if (data) return res.json(400);

    db.store(I, {s: s, v: v, N_bits: N_bits, alg: alg}, function(err) {
      if (err) return res.json(500);
      return res.json(200);
    });
  });
};

/*
 * /hello - initiate a dialogue
 *
 * store parameters locally, and return a session key to the caller.
 *
 * Required params:
 *     identity (string)          the user's identity
 *     ephemeral_pubkey (string)  hex-encoded key (A)
 *
 * Returns:
 *     salt (string)              stored salt for identity
 *     ephemeral_pubkey (string)  hex-encoded key (B)
 *     session_id (string)        session id
 */

exports.hello = function(req, res) {
  var I = req.body.identity;
  var A = bigint(req.body.ephemeral_pubkey, 16);

  if (! (I && A)) {
    return res.json(400);
  }

  db.fetch(I, function(err, data) {
    if (err || !data) {
      // 404 leaks info that identity does not have an account
      // error out with 500?  just as leaky?
      return res.json(404);
    }

    var v = data.v;
    var s = data.s;
    var N = params[data.N_bits].N;
    var g = params[data.N_bits].g;
    var alg = data.alg;

    srp.genKey(function(err, b) {
      if (err) return res.json(500);

      generateSessionId(function(err, key) {
        if (err) return res.json(500);

        var B = srp.getB(v, g, b, N, alg);
        var u = srp.getu(A, B, N, alg);
        var S = srp.server_getS(s, v, N, g, A, b, alg);

        sessions[I + ':' + key] = {
          v: v,
          b: b,
          B: B,
          u: u,
          S: S,
          alg: alg
        };

        return res.json(200, {
          salt: s,
          ephemeral_pubkey: B.toString(16),
          session_id: key});
      });
    });
  });
};

/*
 * /confirm - exchange keys
 *
 * If client can send H(H(K)), I'm convinced she has the right key.
 *
 * Required params:
 *     identity (string)          the user's identity
 *     session_id (string)        session id (from /hello)
 *     challenge (string)         hex-encoded double-hashed key (H(H(K)))
 *
 * Returns:
 *     challenge:                 hex-encoded hashed key (H(K))
 */
exports.confirm = function(req, res) {
  var I = req.body.identity;
  var key = req.body.session_id || '';
  var HHK = req.body.challenge;
  var i = sessions[I + ':' + key];

  if (! (I && key && HHK && i && i.alg && i.v && i.b && i.B && i.u && i.S)) {
    delete sessions[I + ':' + key];
    return res.json(400);
  }

  // decode the challenge
  function H (string_or_buf) {
    return crypto.createHash(i.alg).update(string_or_buf).digest('hex');
  }

  var hhk = H(H(i.S.toBuffer()));
  if (hhk === HHK) {
    res.json(200, {challenge: H(i.S.toBuffer())});
  } else {
    res.json(400);
  }
  delete sessions[I + ':' + key];
};