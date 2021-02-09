const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const _ = require('underscore');
const request = require('request');

const h = require('./helper');
const file = require('./file');
const cache = require('./cache');
const config = require('./config');
const log = require('./log');
const Queue = require('./queue');

class Plugin {
  static plugins = [];
  constructor(id, name, ver, desc, deps) {
    this.id = id;
    this.name = name;
    this.ver = ver || 'default';
    this.desc = desc || '';

    this.enabled = true;
    this.deleted = false;
    this.missing = (this.ver === 'missing');
    this.builtin = (this.ver === 'default');

    // only need deps for current platform
    this.deps = _.chain(deps || [])
      .filter(x => ! x.includes(':') || x.includes(':' + process.platform))
      .map(x => x.split(':')[0])
      .value();
  }

  static #instance;
  static getInstance() {
    if (!this.#instance) {
      this.#instance = new Plugin(99999999, 'core', '20170722', 'Plugins manager');
    }
    return this.#instance;
  }

  init () {
    this.config = config.plugins[this.name] || {};
    this.next = null;
  }

  setNext (next) {
    Object.setPrototypeOf(this, next);
    this.next = next;
  }

  delete () {
    if (!this.missing) {
      try {
        const fullpath = file.pluginFile(this.file);
        file.rm(fullpath);
      } catch(e) {
        return log.error(e.message);
      }
    }
    this.deleted = true;
  }

  save () {
    const stats = cache.get(h.KEYS.plugins) || {};

    if (this.deleted) delete stats[this.name];
    else if (this.missing) return;
    else stats[this.name] = this.enabled;

    cache.set(h.KEYS.plugins, stats);
  }

  install (cb) {
    if (this.deps.length === 0) return cb();

    const cmd = 'npm install --save ' + this.deps.join(' ');
    log.debug(cmd);
    const spin = h.spin(cmd);
    cp.exec(cmd, {cwd: file.codeDir()}, function(e) {
      spin.stop();
      return cb(e);
    });
  }

  static help () {}

  /**
   * @param {Plugin} head
   */
  static init (head) {
    log.trace('initializing all plugins');
    if (!head) {
      head = Plugin.getInstance();
    }

    const stats = cache.get(h.KEYS.plugins) || {};

    // 1. find installed plugins
    let installed = [];
    for (let f of file.listCodeDir('lib/plugins')) {
      const p = f.data;
      if (!p) continue;
      log.trace('found plugin: ' + p.name + '=' + p.ver);

      p.file = f.file;
      p.enabled = stats[p.name];

      if (!(p.name in stats)) {
        if (p.builtin) {
          log.trace('new builtin plugin, enable by default');
          p.enabled = true;
        } else {
          log.trace('new 3rd party plugin, disable by default');
          p.enabled = false;
        }
      }
      installed.push(p);
    }
    // the one with bigger `id` comes first
    installed = _.sortBy(installed, x => -x.id);

    // 2. init all in reversed order
    for (let i = installed.length - 1; i >= 0; --i) {
      const p = installed[i];
      if (p.enabled) {
        p.init();
        log.trace('inited plugin: ' + p.name);
      } else {
        log.trace('skipped plugin: ' + p.name);
      }
    }

    // 3. chain together
    const plugins = installed.filter(x => x.enabled);
    let last = head;
    for (let p of plugins) {
      last.setNext(p);
      last = p;
    }

    // 4. check missing plugins
    const missings = [];
    for (let k of _.keys(stats)) {
      if (installed.find(x => x.name === k)) continue;
      const p = new Plugin(-1, k, 'missing');
      p.enabled = stats[k];
      missings.push(p);
      log.trace('missing plugin:' + p.name);
    }

    Plugin.plugins = installed.concat(missings);
    return missings.length === 0;
  }

  static copy (src, cb) {
    // FIXME: remove local file support?
    if (path.extname(src) !== '.js') {
      src = config.sys.urls.plugin.replace('$name', src);
    }
    const dst = file.pluginFile(src);

    const srcstream = src.startsWith('https://') ? request(src) : fs.createReadStream(src);
    const dststream = fs.createWriteStream(dst);
    let error;

    srcstream.on('response', function(resp) {
      if (resp.statusCode !== 200)
        srcstream.emit('error', 'HTTP Error: ' + resp.statusCode);
    });
    srcstream.on('error', function(e) {
      dststream.emit('error', e);
    });

    dststream.on('error', function(e) {
      error = e;
      dststream.end();
    });
    dststream.on('close', function() {
      spin.stop();
      if (error) file.rm(dst);
      return cb(error, dst);
    });

    log.debug('copying from ' + src);
    const spin = h.spin('Downloading ' + src);
    srcstream.pipe(dststream);
  }
  static install (name, cb) {
    Plugin.copy(name, function(e, fullpath) {
      if (e) return cb(e);
      log.debug('copied to ' + fullpath);

      const p = require(fullpath);
      p.file = path.basename(fullpath);
      p.install(function() {
        return cb(null, p);
      });
    });
  }
  static installMissing (cb) {
    function doTask(plugin, queue, cb) {
      Plugin.install(plugin.name, function(e, p) {
        if (!e) {
          p.enabled = plugin.enabled;
          p.save();
          p.help();
        }
        return cb(e, p);
      });
    }

    const missing = Plugin.plugins.filter(x => x.missing);
    if (missing.length === 0) return cb();

    log.warn('Installing missing plugins, might take a while ...');
    const q = new Queue(missing, {}, doTask);
    q.run(1, cb);
  }

  static save () {
    for (let p of this.plugins) p.save();
  };
}

module.exports = Plugin;
