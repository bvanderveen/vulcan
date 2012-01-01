require.paths.unshift(__dirname + '/lib');

var cradle  = require('cradle');
var express = require('express');
var fs      = require('fs');
var spawner = require('spawner').create();
var sys     = require('sys');
var uuid    = require('node-uuid');
var connect = require('connect');

var app = express.createServer(
  express.logger(),
  express.cookieParser(),
  express.errorHandler({ showStack: true }),
  express.session({ secret: process.env.SECRET }),
  require('connect-form')({ keepExtensions: true })
);

// connect to couchdb
var couchdb_url = require('url').parse(process.env.CLOUDANT_URL);
var couchdb_options = couchdb_url.auth ?
  { auth: { username: couchdb_url.auth.split(':')[0], password: couchdb_url.auth.split(':')[1] }  } :
  { }
var db = new(cradle.Connection)(couchdb_url.hostname, couchdb_url.port || 5984, couchdb_options).database('make');
db.create();

var writeError = function (msg, response, err) {
  response.writeHead(500);

  if (msg) {
    response.write(msg + '\n');
  }

  if (err) {
    response.write('Error occurred: ');
    if (err.name)
      response.write('[' + err.name + '] ');
    
    if (err.message)
      response.write(err.message + '\n');
    else if (err.error)
      response.write(err.error + '\n');
    else {
      var dump = '';
      for (property in object) {
        dump += property + ': ' + object[property]+'; ';
      }
      response.write("Dump of error object: '" + dump + "']\n");
    }
  }
}

// POST /make starts a build
app.post('/make', function(request, response, next) {

  // require a form
  if (! request.form) {
    writeError("did not find form data", response);
  } else {

    // form handler
    request.form.complete(function(err, fields, files) {

      // if there's an error, dump it
      if (err) { 
        writeError("error parsing form", response, err);
      }

      // match on the shared secret
      if (fields.secret != process.env.SECRET) {
        writeError("invalid secret", response);
      } else {

        var id      = uuid();
        var command = fields.command;
        var prefix  = fields.prefix;

        // create a couchdb documents for this build
        db.save(id, { command:command, prefix:prefix }, function(err, doc) {
          if (err) { 
            writeError("error saving doc to couch", response, err);
            return;
          }

          // save the input tarball as an attachment
          db.saveAttachment(
            doc.id,
            doc.rev,
            'input',
            'application/octet-stream',
            fs.createReadStream(files.code.path),
            function(err, data) {
              if (err) {
                writeError("error saving input tarball to couch", response, err);
                return;
              }

              // spawn bin/make with this build id
              var ls = spawner.spawn('bin/make ' + id, function(err) {
                writeError("could not spawn", response, err);
              });

              ls.on('error', function(err) {
                writeError("error from spawner", response, err);
              });

              ls.on('data', function(data) {
                response.write(data);
              });

              ls.on('exit', function(code) {
                response.end();
              });
            }
          );

          // return the build id as a header
          response.header('X-Make-Id', id);
        });
      }
      
    });
  }
});

// download build output
app.get('/output/:id', function(request, response, next) {

  // from couchdb
  var stream = db.getAttachment(request.params.id, 'output');

  stream.on('data', function(chunk) {
    response.write(chunk, 'binary');
  });

  stream.on('end', function(chunk) {
    response.end();
  });

});

// start up the webserver
var port = process.env.PORT || 3000;
console.log('listening on port ' + port);
app.listen(port);
