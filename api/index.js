const Query = require("@irys/query");

module.exports = async (req, res) => {
  const myQuery = new Query({ url: "https://arweave.mainnet.irys.xyz/graphql" });
  const path = req.url.split('?')[0];
  const parts = path.split('/');
  const endpoint = parts[2];
  const address = parts[3];

  try {
    if (endpoint === 'stats') {
      if (!address) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      // Paginate to fetch up to 5000 transactions for the address
      let allTxs = [];
      let lastId = null;
      while (true) {
        const results = await myQuery
          .search("irys:transactions")
          .from([address])
          .limit(100)
          .sort("DESC")
          .after(lastId);
        allTxs = allTxs.concat(results);
        if (results.length < 100) break;
        lastId = results[results.length - 1].id;
        if (allTxs.length >= 5000) break; // Limit for performance
      }

      const txCount = allTxs.length;
      let ageInDays = 0;
      if (txCount > 0) {
        allTxs.sort((a, b) => a.timestamp - b.timestamp);
        const earliestTimestamp = allTxs[0].timestamp;
        const currentTimestamp = new Date("July 12, 2025").getTime();
        ageInDays = Math.floor((currentTimestamp - earliestTimestamp) / (1000 * 60 * 60 * 24));
      }

      res.status(200).json({ txCount, ageInDays });
    } else if (endpoint === 'leaderboard') {
      // Paginate to fetch up to 5000 recent transactions and aggregate
      let allTxs = [];
      let lastId = null;
      while (true) {
        const results = await myQuery
          .search("irys:transactions")
          .limit(100)
          .sort("DESC")
          .after(lastId);
        allTxs = allTxs.concat(results);
        if (results.length < 100) break;
        lastId = results[results.length - 1].id;
        if (allTxs.length >= 5000) break;
      }

      const walletCounts = {};
      allTxs.forEach(tx => {
        const owner = tx.address;
        walletCounts[owner] = (walletCounts[owner] || 0) + 1;
      });

      const leaderboard = Object.entries(walletCounts)
        .map(([address, txCount]) => ({ address, txCount }))
        .sort((a, b) => b.txCount - a.txCount)
        .slice(0, 10); // Top 10

      res.status(200).json({ leaderboard });
    } else {
      res.status(404).json({ error: "Endpoint not found" });
    }
  } catch (e) {
    console.error("Error:", e);
    res.status(500).json({ error: "Failed to fetch data" });
  }
};
