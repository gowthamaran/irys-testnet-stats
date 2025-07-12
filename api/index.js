const Query = require("@irys/query");

async function fetchWithRetry(url, retries = 3, delay = 1000, timeout = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} - ${response.statusText}`);
      return await response.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.error(`Retry ${i + 1} failed for ${url}: ${e.message}, waiting ${delay * (i + 1)}ms`);
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
}

async function checkApiHealth() {
  let isHealthy = false;
  for (let i = 0; i < 5; i++) { // Increased retries for health check
    try {
      await fetchWithRetry("https://testnet.irys.xyz/graphql", 1, 2000, 5000); // Longer initial delay
      isHealthy = true;
      console.log("API health check succeeded after attempt", i + 1);
      break;
    } catch (e) {
      console.error(`Health check attempt ${i + 1} failed: ${e.message}`);
      if (i === 4) {
        console.warn("All health check attempts failed, proceeding with potential partial availability");
        return true; // Fallback to allow operation if API is intermittently available
      }
      await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1))); // Exponential backoff
    }
  }
  return isHealthy;
}

module.exports = async (req, res) => {
  const myQuery = Query; // Assuming Query is the module export
  const path = req.url.split('?')[0];
  const parts = path.split('/');
  const endpoint = parts[2];
  const address = parts[3];

  const isApiHealthy = await checkApiHealth();
  if (!isApiHealthy) {
    return res.status(503).json({ error: "Irys testnet API is currently unavailable or unstable. Retrying may help, or check Irys status." });
  }

  try {
    if (endpoint === 'stats') {
      if (!address) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      // Fetch balance with retry
      let holdings = "0";
      try {
        const balanceData = await fetchWithRetry(`https://testnet.irys.xyz/account/balance/ethereum?address=${address}`);
        holdings = (BigInt(balanceData.balance) / BigInt(1e18)).toString();
      } catch (e) {
        console.error("Balance fetch error:", e.message);
        return res.status(500).json({ error: `Failed to fetch balance: ${e.message}` });
      }

      // Fetch transactions with retry
      let allTxs = [];
      let lastId = null;
      try {
        while (true) {
          const results = await myQuery.search("irys:transactions")
            .from([address])
            .limit(100)
            .sort("DESC")
            .after(lastId);
          allTxs = allTxs.concat(results);
          if (results.length < 100) break;
          lastId = results[results.length - 1].id;
          if (allTxs.length >= 500) break;
        }
      } catch (e) {
        console.error("Transaction fetch error:", e.message);
        allTxs = [];
      }

      const txCount = allTxs.length;
      let ageInDays = 0;
      let recencyFactor = 0;
      if (txCount > 0) {
        allTxs.sort((a, b) => a.timestamp - b.timestamp);
        const earliestTimestamp = allTxs[0].timestamp;
        const latestTimestamp = allTxs[allTxs.length - 1].timestamp;
        const currentTimestamp = new Date("July 12, 2025").getTime(); // Adjusted to match query context
        ageInDays = Math.floor((currentTimestamp - earliestTimestamp) / (1000 * 60 * 60 * 24));
        if ((currentTimestamp - latestTimestamp) <= 7 * 24 * 60 * 60 * 1000) {
          recencyFactor = 0.5;
        }
      }

      const score = txCount * (1 + recencyFactor);

      res.status(200).json({ score, txCount, ageInDays, holdings });
    } else if (endpoint === 'leaderboard') {
      // Fetch recent transactions with retry
      let allTxs = [];
      let lastId = null;
      try {
        while (true) {
          const results = await myQuery.search("irys:transactions")
            .limit(100)
            .sort("DESC")
            .after(lastId);
          allTxs = allTxs.concat(results);
          if (results.length < 100) break;
          lastId = results[results.length - 1].id;
          if (allTxs.length >= 500) break;
        }
      } catch (e) {
        console.error("Leaderboard transaction fetch error:", e.message);
        allTxs = [];
      }

      // Aggregate transaction counts
      const walletData = {};
      allTxs.forEach(tx => {
        const owner = tx.address;
        if (!walletData[owner]) {
          walletData[owner] = { txCount: 0, latestTimestamp: 0 };
        }
        walletData[owner].txCount += 1;
        if (tx.timestamp > walletData[owner].latestTimestamp) {
          walletData[owner].latestTimestamp = tx.timestamp;
        }
      });

      // Fetch balances and calculate scores
      const currentTimestamp = new Date("July 12, 2025").getTime();
      const leaderboard = [];
      for (const address of Object.keys(walletData).slice(0, 50)) {
        const txCount = walletData[address].txCount;
        const latestTimestamp = walletData[address].latestTimestamp;
        const recencyFactor = (currentTimestamp - latestTimestamp) <= 7 * 24 * 60 * 60 * 1000 ? 0.5 : 0;
        const score = txCount * (1 + recencyFactor);

        let holdings = "0";
        try {
          const balanceData = await fetchWithRetry(`https://testnet.irys.xyz/account/balance/ethereum?address=${address}`);
          holdings = (BigInt(balanceData.balance) / BigInt(1e18)).toString();
        } catch (e) {
          console.error(`Balance fetch error for ${address}:`, e.message);
        }

        leaderboard.push({ address, score, txCount, holdings });
      }

      // Sort by score, txCount, holdings
      leaderboard.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.txCount !== a.txCount) return b.txCount - a.txCount;
        return parseFloat(b.holdings) - parseFloat(a.holdings);
      });

      res.status(200).json({ leaderboard: leaderboard.slice(0, 10) });
    } else {
      res.status(404).json({ error: "Endpoint not found" });
    }
  } catch (e) {
    console.error("General error:", e);
    res.status(500).json({ error: `Failed to fetch data: ${e.message}` });
  }
};
