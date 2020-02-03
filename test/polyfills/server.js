"use strict";

require("hard-rejection/register");
const semver = require("semver");
const polyfillio = require("../../lib/index");
const fs = require("fs");
const promisify = require("util").promisify;
const readFile = promisify(fs.readFile);
const path = require("path");
const handlebars = require("handlebars");

const directorTemplate = handlebars.compile(
  fs.readFileSync(path.join(__dirname, "./test-director.handlebars"), {
    encoding: "UTF-8"
  })
);
const runnerTemplate = handlebars.compile(
  fs.readFileSync(path.join(__dirname, "./test-runner.handlebars"), {
    encoding: "UTF-8"
  })
);

function createPolyfillLibraryConfigFor(features, always) {
  return features.split(",").reduce((config, feature) => {
    return Object.assign(config, {
      [feature]: {
        flags: new Set(always ? ["always", "gated"] : [])
      }
    });
  }, {});
}

const express = require("express");

const app = express();
const port = 9876;

app.get(["/test"], createEndpoint(runnerTemplate, polyfillio));
app.get(["/"], createEndpoint(directorTemplate, polyfillio));
app.get("/mocha.js", (request, response) => {
  response.sendfile(require.resolve("mocha/mocha.js"));
});
app.get("/proclaim.js", (request, response) => {
  response.sendfile(require.resolve("proclaim/lib/proclaim.js"), "utf-8");
});

app.get("/polyfill.js", async (request, response) => {
  const polyfillsWithTests = await testablePolyfills();
  const features = polyfillsWithTests.map(polyfill => polyfill.feature);
  const params = {
    features: createPolyfillLibraryConfigFor(features.join(",")),
    minify: false,
    stream: true,
    uaString: "other/0.0.0"
  };

  const headers = {
    "Content-Type": "text/javascript; charset=utf-8"
  };
  response.status(200);
  response.set(headers);

  polyfillio.getPolyfillString(params).pipe(response);
});

app.listen(port, () => console.log(`Test server listening on port ${port}!`));

async function testablePolyfills(isIE8) {
  const polyfills = await polyfillio.listAllPolyfills();
  const polyfilldata = [];

  for (const polyfill of polyfills) {
    const config = await polyfillio.describePolyfill(polyfill);
    if (config.isTestable && config.isPublic && config.hasTests && isIE8 && !semver.satisfies("8.0.0", config.browsers.ie)) {
      continue;
    }
    if (config.isTestable && config.isPublic && config.hasTests) {
      const baseDir = path.resolve(__dirname, "../../polyfills");
      const testFile = path.join(baseDir, config.baseDir, "/tests.js");
      const testSuite = `describe('${polyfill}', function() { 
        it('passes the feature detect', function() {
          proclaim.ok((function() {
            return (${config.detectSource});
          }).call(window));
        });

        ${await readFile(testFile)}
      });`;
      polyfilldata.push({
        feature: polyfill,
        testSuite
      });
    }
  }

  polyfilldata.sort(function(a, b) {
    return a.feature > b.feature ? -1 : 1;
  });

  return polyfilldata;
}

function createEndpoint(template) {
  return async (request, response) => {
    const ua = request.get("User-Agent");
    const isIE8 = polyfillio.normalizeUserAgent(ua) === "ie/8.0.0";
    const feature = request.query.feature || "";
    const includePolyfills = request.query.includePolyfills || "no";
    const always = request.query.always || "no";

    if (includePolyfills !== "yes" && includePolyfills !== "no") {
      response.status(400);
      response.send(
        "includePolyfills query parameter is an invalid value, it can only be 'yes' or 'no'."
      );
      return;
    }
    
    if (always !== "yes" && always !== "no") {
      response.status(400);
      response.send(
        "always query parameter is an invalid value, it can only be 'yes' or 'no'."
      );
      return;
    }

    const polyfills = await testablePolyfills(isIE8);

    // Filter for querystring args
    const features = feature
      ? polyfills.filter(polyfill => feature === polyfill.feature)
      : polyfills;

    const testSuite = features.map(feature => feature.testSuite).join("\n");
    const testSetup = [
      await readFile(require.resolve("mocha/mocha.js"), "utf-8"),
      await readFile(require.resolve("proclaim/lib/proclaim.js"), "utf-8"),
      "mocha.setup('bdd');"
    ];

    let beforeTestSuite = "";
    if (includePolyfills === "yes") {
      const polyfillsWithTests = await testablePolyfills(isIE8);
      const features = polyfillsWithTests.map(polyfill => polyfill.feature);
      const params = {
        features: createPolyfillLibraryConfigFor(feature ? feature : features.join(","), always === "yes"),
        minify: false,
        stream: false,
        uaString: always === "yes" ? "other/0.0.0" : request.get('user-agent')
      };

      beforeTestSuite = await polyfillio.getPolyfillString(params);
    }

    if (testSuite.length === 0) {
      response.status(400);

      response.send(
        "no polyfills match the requested feature in the feature query parameter."
      );
    } else {
      response.status(200);

      response.set({
        "Content-Type": "text/html; charset=utf-8"
      });

      response.send(
        template({
          features: features,
          styles: await readFile(require.resolve("mocha/mocha.css"), "utf-8"),
          testSetup: Array.isArray(testSetup) ? testSetup : [testSetup],
          beforeTestSuite: beforeTestSuite,
          testSuite: testSuite,
          includePolyfills: includePolyfills,
          always: always,
          afterTestSuite: `
          // During the test run, surface the test results in Browserstacks' preferred format
          function run() {
            // Given a test, get the first level suite that it is contained within
            // Not the top level, the first one down.
            function getFirstLevelSuite(test) {
              var parent = test;
              while (parent && parent.parent && parent.parent.parent) {
                parent = parent.parent;
              }
              return parent.title;
            }
            var runner = mocha.run();
            var results = {
              state: 'complete',
              passed: 0,
              failed: 0,
              total: 0,
              duration: 0,
              tests: [],
              failingSuites: {},
              testedSuites: [],
              uaString: window.navigator.userAgent || 'unknown'
            };
            runner.on('pass', function(test) {
              results.passed++;
              results.total++;
            });
            runner.on('fail', function(test, err) {
              // Get a set of all the suites with failing tests in them.
              if (test.parent) {
                results.failingSuites[getFirstLevelSuite(test)] = true;
              }
              results.failed++;
              results.total++;
              results.tests.push({
                name: test.fullTitle(),
                result: false,
                message: err.message,
                stack: err.stack,
                failingSuite: getFirstLevelSuite(test)
              });
            });
            runner.on('suite', function(suite) {
              results.testedSuites.push(getFirstLevelSuite(suite));
            });
            runner.on('end', function() {
              window.global_test_results = results;
              if (parent && parent.receiveTestResults) {
                var flist = ["${feature}"];
                parent.receiveTestResults(flist, results);
              }
            });
          }
          run();`
        })
      );
    }
  };
}
