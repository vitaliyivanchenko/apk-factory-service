/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var exec = require('child_process').exec;
var path = require('path');
var url = require('url');

var _ = require('underscore');
var fs = require('fs.extra');
var nunjucks = require('nunjucks');

var androidify = require('./manifest_androidifier');
var fsUtil = require('./fs_util');

var KEYSTORE_PASSWORD = "mozilla",
    ALIAS_NAME = "alias",
    ALIAS_PASSWORD = "alias_password";

// TODO: loader is too tightly coupled with several modules
var ApkProject = function (src, dest, loader) {
  dest = dest || (process.env.TMPDIR + "/app");

  this.src = path.resolve(__dirname, "../node_modules/apk-factory-library/", src);
  this.dest = path.resolve(process.cwd(), dest);

  this.env = new nunjucks.Environment([new nunjucks.FileSystemLoader(this.src),
                                       new nunjucks.FileSystemLoader(path.resolve(__dirname, "..", "util-templates"))]);

  this.loader = loader;
};

_.extend(ApkProject.prototype, {
  _makeNewSkeleton: function (cb) {

    try {
      if (fs.existsSync(this.dest)) {
        fs.rmrfSync(this.dest);
      }

      fs.mkdirpSync(this.dest);
    } catch(e) {
      throw e;
    }

    this.dest = fs.realpathSync(this.dest);
    fs.copyRecursive(this.src, this.dest, cb);

    // Create the src/ subdirectory, which ant needs to build the project,
    // but which doesn't exist in the template because it's empty (and you
    // can't control the revisions of a directory in Git).
    fs.mkdirpSync(path.resolve(this.dest, "src"));
  },

  _templatize: function (filesuffix, destFileSuffix, obj) {
    if (arguments.length === 2) {
      obj = destFileSuffix;
      destFileSuffix = filesuffix;
    }



    var out = this.env.render(filesuffix, obj),
        fileout = path.resolve(this.dest, destFileSuffix);

    if (fs.existsSync(fileout)) {
      fs.unlinkSync(fileout);
    }
    writeFileSync(fileout, out);
  },

  create: function (manifestUrl, manifest, appType, cb) {
    if (_.isObject(manifest) && _.isString(manifestUrl)) {
      // continue;
    } else {
      throw "A JSON manifest is required, with a valid manifestUrl";
    }

    var self = this;

    self.manifestUrl = manifestUrl;
    self.manifest = manifest;

    self._makeNewSkeleton(function (err) {
      if (err) {
        if (cb) {
          cb(err);
        } else {
          console.error(err);
        }
        return;
      }

      var androidManifestProperties = {
        version: manifest.version,
        versionCode: androidify.versionCode(manifest.version),
        manifestUrl: manifestUrl,
        appType: appType,
        permissions: androidify.permissions(manifest.permissions),
        packageName: androidify.packageName(manifestUrl)
      };

      self._templatize("AndroidManifest.xml", androidManifestProperties);

      var stringsObj = {
        name: manifest.name,
        description: manifest.description || ""
      }, re = /^(\w+)(?:-(\w+))?$/mg;

      if (manifest.default_locale && manifest.locales) {
        _.each(manifest.locales, function (i, locale) {
          var localizedStrings = _.extend({}, stringsObj, manifest.locales[locale]);

          locale = locale.replace(re,
                    function (match, lang, country) {
                      if (lang.length > 2) {
                        return null;
                      }
                      if (country) {
                        return lang + "-r" + country.toUpperCase();
                      }
                      return lang;
                    }
                  );
          if (locale === "value-null") {
            self._templatize("res/values/strings.xml",
                            "res/values-" + locale +  "/strings.xml",
                            localizedStrings);
          }
        });

        var localizedStrings = _.extend({}, stringsObj, manifest.locales[manifest.default_locale]);
        self._templatize("res/values/strings.xml", localizedStrings);

      } else {
        self._templatize("res/values/strings.xml", stringsObj);
      }

      self._templatize("build.xml", self._sanitize(stringsObj));

      writeFileSync(path.join(self.dest, "res/raw/manifest.json"), JSON.stringify(manifest));

      var icons = manifest.icons || {};
      var iconsLeft = _.size(icons);

      if (!iconsLeft) {
        // strange!
        cb(androidManifestProperties);
      }

      function downloaderCallback () {
        iconsLeft --;
        if (iconsLeft <= 0 && _.isFunction(cb)) {
          cb(androidManifestProperties);
        }
      }

      _.each(icons, function (i, key) {
        var dest = path.join(self.dest, "res/drawable-" + androidify.iconSize(key) + "/ic_launcher.png");
        self.loader.copy(icons[key], dest, downloaderCallback);
      });
    });
  },

  _sanitize: function (value) {
    if (_.isString(value)) {
      return value.replace(/[^\w\.]+/g, "");
    }

    var self = this;
    _.each(value, function (i, key) {
      value[key] = self._sanitize(value[key]);
    });
    return value;
  },

  build: function (keyDir, cb) {

    var self = this;

    var hostname = url.parse(this.manifestUrl).hostname,
        keyFile = path.join(keyDir, hostname),
        projectProperties = {
          libraryProject: path.relative(self.dest, path.resolve(__dirname, "..", "node_modules", "apk-factory-library")),
          keystore: keyFile,
          keystore_password: KEYSTORE_PASSWORD,
          alias: ALIAS_NAME,
          alias_password: ALIAS_PASSWORD
        };

    self._templatize("project.properties", projectProperties);

    function buildWithAnt() {
      exec("(cd " + self.dest + "; ant release)", function (error, stdout, stderr) {
        var apkLocation = path.join(self.dest, "bin", self._sanitize(self.manifest.name) + "-release.apk");

        if (error) {
          console.error(error);
          console.error(stderr);
        }

        if (cb) {
          cb(error, apkLocation);
        }
      });
    }


    if (!fs.existsSync(keyFile)) {

      var developer = self.manifest.developer || {};

      var genKeyCommand = this.env.render("keygen.sh", {
        keystore: keyFile,
        store_password: KEYSTORE_PASSWORD,

        alias: ALIAS_NAME,
        alias_password: ALIAS_PASSWORD,

        // TODO: drag this out of the manifest.
        commonName: developer.name || "Unknown",
        organizationUnit: developer.url || "Unknown",
        organization: hostname,
        city: "Unknown",
        state: "Unknown",
        countryCode: "XX"
      });

      exec(genKeyCommand, function (error, stdout, stderr) {
        if (!error) {
          buildWithAnt();
          return;
        } else {
          console.error(error);
          console.error(stderr);
        }
      });

    } else {
      buildWithAnt();
    }

  },

  cleanup: function () {
    fs.rmrfSync(this.dest);
  }

});

function writeFileSync(filename, content) {
  fsUtil.ensureDirectoryExistsFor(filename);
  fs.writeFileSync(filename, content);
}

module.exports = {
  ApkProjectCreator: ApkProject
};