"use strict";

const denodeify = require("util").promisify;
const fs = require("fs");
const TOML = require("@iarna/toml");
// Grab all the browsers from BrowserStack which are officially supported by the polyfil service.
const browsers = TOML.parse(
  fs.readFileSync("./test/polyfills/browserstackBrowsers.toml", "utf-8")
).browsers;

if (
  !process.env.BROWSERSTACK_USERNAME ||
  !process.env.BROWSERSTACK_ACCESS_KEY
) {
  throw new Error(
    "BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY must be set in the environment to run tests on BrowserStack.  For more information about how to set this up or for alternative methods of testing, see https://polyfill.io/v2/docs/contributing/testing"
  );
}

module.exports = {
  creds: {
    username: process.env.BROWSERSTACK_USERNAME,
    key: process.env.BROWSERSTACK_ACCESS_KEY
  },
  tunnel: function() {
    const Tunnel = require("browserstack-local").Local;
    const tunnel = new Tunnel();
    return {
      openTunnel: () =>
        new Promise(resolve => {
          tunnel.start(
            {
              verbose: "true",
              force: "true",
              onlyAutomate: "true",
              forceLocal: "true"
            },
            error => {
              if (error) {
                console.error("Failed to open tunnel");
                console.error(error);
                throw error;
              }
              resolve();
            }
          );
        }),
      closeTunnel: () => denodeify(tunnel.stop.bind(tunnel))()
    };
  },
  host: "hub-cloud.browserstack.com",
  port: 80,
  useragentToBrowserObj: browserWithVersion => {
    const [browser, version] = browserWithVersion.split("/");
    const browserObj = browsers.find(browserObject => {
      if (
        browser === browserObject.os &&
        version === browserObject.os_version
      ) {
        return true;
      } else if (
        browser === browserObject.browser &&
        version === browserObject.browser_version
      ) {
        return true;
      } else {
        return false;
      }
    });

    if (browserObj) {
      return browserObj;
    } else {
      throw new Error(
        `Browser: ${browser} with version ${version} was not found on BrowserStack.`
      );
    }
  }
};
