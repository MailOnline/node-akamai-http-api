/**
 * Licensed under the MIT License
 *
 * @author   Kanstantsin A Kamkou (2ka.by), Alexander Günther
 * @license  http://www.opensource.org/licenses/mit-license.php The MIT License
 * @link     https://github.com/kkamkou/node-akamai-http-api
 * 
 * Modified by MattW for MoL to support .create() method, and 
 * extended for multiple instances to allow different cpcodes/configs
 * to be used at the same time. This requires a change in signature. Rather
 * than:
 * 		akamai = require('akamai-http-api') ;
 * use:
 * 		akamai = require('akamai-http-api').setConfig({config}) ;
 */

// required stuff
var request = require('request'),
  Stream = require('stream'),
  path = require('path'),
  crypto = require('crypto'),
  xml2js = require('xml2js'),
  qs = require('querystring'),
  _ = require('lodash');

// the class itself
var akamai = {} ;

/**
 * Generates a random number
 *
 * @returns {String}
 */
akamai.getUniqueId = function () {
  var str = '';
  for (var i = 0, r; i < 6; i++) {
    if ((i & 0x03) === 0) {
      r = Math.random() * 0x100000000;
    }
    str += r >>> ((i & 0x03) << 3) & 0xff;
  }
  return str + process.pid;
};

/**
 * Returns the config object
 *
 * @returns {Object}
 */
akamai.getConfig = function () {
  return this.config;
};

/**
 * Returns a set of headers for the authentication process
 *
 * @param {String} path
 * @param {Object} queryObj
 * @returns {Object}
 */
akamai.getHeaders = function (path, queryObj) {
  var authData, authSign, query;

  query = qs.stringify(_.merge({version: 1, action: 'du', format: 'xml'}, queryObj || {}));

  authData = [
    5, '0.0.0.0', '0.0.0.0', parseInt(Date.now() / 1000, 10), this.getUniqueId(),
    this.getConfig().keyName
  ].join(', ');

  authSign = crypto.createHmac('sha256', this.getConfig().key)
    .update([authData + path.replace(/\/$/, ''), 'x-akamai-acs-action:' + query, null].join("\n"))
    .digest('base64');

  return {
    'X-Akamai-ACS-Action': query,
    'X-Akamai-ACS-Auth-Data': authData,
    'X-Akamai-ACS-Auth-Sign': authSign
  };
};

/**
 * Adds http or https to the host
 *
 * @param {String} path
 * @returns {String}
 */
akamai.getUri = function (path) {
  var host = ['http', this.getConfig().ssl ? 's' : '', '://', this.getConfig().host].join('');
  return [host, path.replace(/(^\/|\/$)/g, '')].join('/');
};

/**
 * Converts a xml string to an object
 *
 * @param {String} data
 * @param {Function} cb
 */
akamai.getObjectFromXml = function (data, cb) {
  (new xml2js.Parser())
    .parseString(data, function (err, result) {
      if (err) {
        return cb(err);
      }

      cb(null, _.merge({}, result, function (a, b) {
        var obj = {};
        Object.keys(b).forEach(function (key) {
          if (key === '$') {
            obj.attribs = b[key];
          } else if (_.isArray(b[key])) {
            obj[key] = _.pluck(b[key], '$');
          }
        });
        return obj;
      }));
    });
};

/**
 * Returns a request object for streaming
 *
 * @param {String} path
 * @param {Object} params
 * @param {Function} cb
 * @returns {request}
 */
akamai.getRequestObject = function (path, params, cb) {
  var self = this,
    callback = function () {},
    options = _.merge(
      {url: this.getUri(path), headers: this.getHeaders(path, params.headers)},
      params.request
    );

  var reqOptions = this.getConfig().request ;
  if (reqOptions) {
	_.assign(options,reqOptions) ;
  }
  
  if (typeof(cb) === 'function') {
    callback = function (err, resp, body) {
      // we have an error
      if (err) {
        return cb(err);
      }

      // wrong response code
      if (resp.statusCode >= 300) {
        var errMsg = 'The server sent us the ' + resp.statusCode + ' code';
        if (self.getConfig().verbose && body) {
          errMsg += '. Body: ' + body;
        }
        err = new Error(errMsg) ;
        err.status = resp.statusCode ;
        return cb(err);
      }

      if (!body.match(/^<\?xml\s+/)) {
        return cb(null, {status: resp.statusCode});
      }

      self.getObjectFromXml(body, cb);
    };
  }

  return request(options, callback);
};

/** Custom helpers **/

akamai.fileExists = function (path, cb) {
  return this.stat(path, function (err, data) {
    if (err && err.message.indexOf('404 code') !== -1) {
      return cb(null, false);
    }
    if (data && data.stat && data.stat.file) {
      return cb(null, true);
    }
    return cb(err);
  });
};

/** Api functions **/

akamai.upload = function (stream, path, cb) {
  var options = {
    request: {method: 'put'},
    headers: {action: 'upload', 'upload-type': 'binary'}
  };
  stream.pipe(this.getRequestObject(path, options, cb));
  return this;
};

akamai.download = function (path, stream, cb) {
  this.getRequestObject(path, {headers: {action: 'download'}}, cb).pipe(stream);
  return this;
};

akamai.stat = function (path, cb) {
  this.getRequestObject(path, {headers: {action: 'stat'}}, cb);
  return this;
};

akamai.du = function (path, cb) {
  this.getRequestObject(path, {headers: {action: 'du'}}, cb);
  return this;
};

akamai.dir = function (path, cb) {
  this.getRequestObject(path, {headers: {action: 'dir'}}, cb);
  return this;
};

akamai.delete = function (path, cb) {
  this.getRequestObject(path, {request: {method: 'put'}, headers: {action: 'delete'}}, cb);
  return this;
};

akamai.mkdir = function (path, cb) {
  this.getRequestObject(path, {request: {method: 'put'}, headers: {action: 'mkdir'}}, cb);
  return this;
};

akamai.rmdir = function (path, cb) {
  this.getRequestObject(path, {request: {method: 'put'}, headers: {action: 'rmdir'}}, cb);
  return this;
};

akamai.rename = function (pathFrom, pathTo, cb) {
  var options = {
    request: {method: 'put'},
    headers: {action: 'rename', destination: pathTo}
  };
  this.getRequestObject(pathFrom, options, cb);
  return this;
};

akamai.symlink = function (pathFileTo, pathFileFrom, cb) {
  var options = {
    request: {method: 'put'},
    headers: {action: 'symlink', target: pathFileTo}
  };
  this.getRequestObject(pathFileFrom, options, cb);
  return this;
};

akamai.mtime = function (path, date, cb) {
  if (!(date instanceof Date)) {
    return cb(new TypeError('The date has to be an instance of Date'));
  }

  var options = {
    request: {method: 'put'},
    headers: {action: 'mtime', mtime: parseInt(date.getTime() / 1000, 10)}
  };
  this.getRequestObject(path, options, cb);
  return this;
};

/* Added by MattW for MOL */
/* Like upload, but creates the path beforehand */
akamai.create = function(source /*stream*/, cpcode, target, callback) {
	var self = this ;

	function mkdir(path,idx,done) {
    	if (idx>path.length)
    		return done(null) ;
		idx += 1 ;
    	var l = path.slice(0,idx) ;
    	self.mkdir(l.join("/"),function(err){
    		if (err && err.status!=409)
    			return done(err) ;
    		mkdir(path,idx,done) ;
    	});
	}

    // Create path
	target = path.join("/", "" + cpcode, "/", target) ;
    var dirPath = target.split("/") ;
    dirPath = dirPath.slice(0,dirPath.length-1).join("/") ;
    
    mkdir(dirPath.split("/"),1,function(err){
        if (err) {
            err.message = "mkdir "+err.message+"\t"+JSON.stringify(self.getConfig()) ;
            return callback && callback(err);
        }
        if (!("pipe" in source)) { 
        	// Probabaly not a stream
        	var original = source ;
        	source = new Stream();
        	source.pipe = function(dest) {
        	  dest.write(original);
        	  return dest;
        	};        
        }
    	self.upload(source, target, function(err){
            if (err) {
                err.message = err.message+"\t"+JSON.stringify(self.getConfig()) ;
                return callback && callback(err);
            }
            callback && callback();
    	}) ;
    }) ;
}


// exporting outside
module.exports = {
	setConfig:function(config){
		return Object.create(akamai,{config:{value:_.assign({},config)}}) ;
	}
};
