const prompt = require("prompt");
const csv = require("csv-parser");
const fastcsv = require("fast-csv");
const fs = require("fs");
const puppeteer = require("puppeteer");
const asyncForEach = require("sequential-async-foreach").asyncForEach;

const WAIT_TIME_BETWEEN_BROWSING = 3000;
const CHUNK_SIZE = 5;

prompt.start();

prompt.get(["suburb"], async function (err, result) {
  if (err) {
    return onErr(err);
  }

  const { suburb } = result;
  let suburbData = [];

  if (fs.existsSync(`csv/${suburb}-links.csv`)) {
    console.log(`Links for ${suburb} exist, fetching estimates`);

    processCsv(
      `csv/${suburb}-links.csv`,
      function (row) {
        suburbData = [...suburbData, row];
      },
      async function () {
        const start = Date.now();

        // const suburbDataChunks = arrayChunks(
        //   suburbData,
        //   Math.ceil(suburbData.length / CHUNK_SIZE)
        // );

        // const suburbDataPromises = arrayOfArraysPromise(
        //   suburbDataChunks,
        //   processEstimateData
        // );

        // const data = await Promise.all(suburbDataPromises).then(
        //   (suburbDataChunk) => {
        //     return [].concat.apply([], suburbDataChunk);
        //   }
        // );
        // const estimates = await processEstimateData(suburbData);

        const estimates = await Promise.all([
          new Promise((resolve) => processEstimateData(suburbData, resolve)),
        ]).then((suburbEstimates) => {
          return [].concat.apply([], suburbEstimates);
        });

        console.log(`Total elapsed time: ${msToTime(Date.now() - start)}`);
        writeCsv(`${suburb}-estimates`, estimates);
      }
    );
  } else if (fs.existsSync(`csv/${suburb}.csv`)) {
    console.log(`Data for ${suburb} already exists`);

    processCsv(
      `csv/${suburb}.csv`,
      function (row) {
        suburbData = [...suburbData, row];
      },
      async function () {
        const start = Date.now();

        const suburbDataChunks = arrayChunks(
          suburbData,
          Math.ceil(suburbData.length / CHUNK_SIZE)
        );

        const suburbDataPromises = arrayOfArraysPromise(
          suburbDataChunks,
          processHomeLinks
        );

        const data = await Promise.all(suburbDataPromises).then(
          (suburbDataChunk) => {
            return [].concat.apply([], suburbDataChunk);
          }
        );

        console.log(`Total elapsed time: ${msToTime(Date.now() - start)}`);
        writeCsv(`${suburb}-links`, data.flat());
      }
    );
  } else {
    console.log(`Data for ${suburb} does not exist, creating new file`);

    processCsv(
      "csv/nz-street-address.csv",
      function (row) {
        const { suburb_locality } = row;
        if (suburb.toLowerCase() === suburb_locality.toLowerCase()) {
          suburbData = [...suburbData, row];
        }
      },
      function () {
        writeCsv(suburb, suburbData);
      }
    );
  }
});

function processCsv(path, onDataFunc, onEndFunc) {
  fs.createReadStream(path)
    .pipe(csv())
    .on("data", (row) => {
      onDataFunc(row);
    })
    .on("error", (err) => {
      console.log("Error while processing CSV file");
      console.log(err);
    })
    .on("end", () => {
      console.log("CSV file successfully processed");
      onEndFunc();
    });
}

function onErr(err) {
  console.log(err);
  return 1;
}

function writeCsv(filename, data) {
  const ws = fs.createWriteStream(`csv/${filename}.csv`);

  fastcsv.write(data, { headers: true }).pipe(ws);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processHomeLinks(suburbData, resolveFunc) {
  console.log("Starting to process links...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const totalSuburbs = suburbData.length;
  let totalSuburbsProcessed = 0;

  let homeLinks = [];

  await asyncForEach(suburbData, async (suburb) => {
    const { full_address } = suburb;
    console.log(`Processing ${full_address}\n`);

    await page.goto("https://homes.co.nz/");

    await page.type("input[id=autocomplete-search]", full_address);
    await sleep(WAIT_TIME_BETWEEN_BROWSING);

    const [searchButton] = await page.$x("//button[contains(., 'Search')]");
    if (searchButton) {
      await searchButton.click();
    }
    await sleep(WAIT_TIME_BETWEEN_BROWSING);

    const [listButton] = await page.$x("//button[contains(., 'List')]");
    if (listButton) {
      await listButton.click();
    }
    await sleep(WAIT_TIME_BETWEEN_BROWSING);

    // await page.screenshot({ path: `screenshots/${full_address}.png` });

    const [h3PropertyNotFound] = await page.$x(
      "//h3[contains(., 'We couldn’t find that property')]"
    );
    if (!h3PropertyNotFound) {
      const detailsLink = await page.$eval(".detailsLink", (el) => el.href);
      if (detailsLink) {
        console.log(`Link for ${full_address}: ${detailsLink}\n`);
        homeLinks = [
          ...homeLinks,
          { full_address: full_address, link: detailsLink },
        ];
      }
    } else {
      console.log(`Could not find details for ${full_address}\n`);
    }

    console.log(
      `Progress: ${calculatePercentage(
        ++totalSuburbsProcessed,
        totalSuburbs
      ).toFixed(2)}%\n`
    );
  });

  await browser.close();

  return resolveFunc(homeLinks);
}

async function processEstimateData(suburbData, resolveFunc) {
  console.log("Starting to process estimates...");
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const totalSuburbs = suburbData.length;
  let totalSuburbsProcessed = 0;

  let estimates = [];

  await asyncForEach(suburbData, async (suburb) => {
    const { full_address, link } = suburb;
    console.log(`Processing ${full_address}\n`);

    await page.goto(link);
    await sleep(1000);

    const estimateDate = await page
      .$eval(".date", (el) => el.textContent.replace("HomesEstimate: ", ""))
      .catch((err) => console.log(err));

    const estimateValue = await page
      .$eval(".display_price", (el) => el.textContent)
      .catch((err) => console.log(err));

    const estimateRange = await page
      .$eval(".estimate_range_price", (el) => el.textContent)
      .catch((err) => console.log(err));

    console.log(`Estimate for ${full_address}: $${estimateValue}\n`);

    estimates = [
      ...estimates,
      {
        full_address: full_address,
        estimate_date: estimateDate,
        estimate_value: `$${estimateValue}`,
        estimate_range: estimateRange,
        link: link,
      },
    ];

    console.log(
      `Progress: ${calculatePercentage(
        ++totalSuburbsProcessed,
        totalSuburbs
      ).toFixed(2)}%\n`
    );
  });

  await browser.close();

  return resolveFunc(estimates);
}

function calculatePercentage(numerator, denominator) {
  return (numerator / denominator) * 100;
}

function arrayChunks(array, chunkSize) {
  return Array(Math.ceil(array.length / chunkSize))
    .fill()
    .map((_, index) => index * chunkSize)
    .map((begin) => array.slice(begin, begin + chunkSize));
}

function arrayOfArraysPromise(arrayOfArrays, func) {
  return arrayOfArrays.map(
    (array) =>
      new Promise((resolve) => {
        func(array, resolve);
      })
  );
}

new Promise((resolve) => {
  setTimeout(() => resolve(3), 3000);
});
function msToTime(ms) {
  let seconds = (ms / 1000).toFixed(1);
  let minutes = (ms / (1000 * 60)).toFixed(1);
  let hours = (ms / (1000 * 60 * 60)).toFixed(1);
  let days = (ms / (1000 * 60 * 60 * 24)).toFixed(1);
  if (seconds < 60) return seconds + " Sec";
  else if (minutes < 60) return minutes + " Min";
  else if (hours < 24) return hours + " Hrs";
  else return days + " Days";
}
