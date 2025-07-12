const Query = require("@irys/query");

module.exports = async (req, res) => {
  const myQuery = new Query({ url: "https://testnet.irys.xyz/graphql" });
  const path = req.url.split('?')[0];
  const parts = path.split('/');
  const endpoint = parts[2];
  const address = parts[3];

  try {
    if (endpoint === 'stats') {
      if (!address) {
        return res.status(400).json({ error: "Wallet address required" });
      }

      // Fetch balance
      const balanceRes = await fetch(`https://testnet.irys.xyz/account/balance/ethereum?address=${address}`);
      if (!balanceRes.ok) throw new Error("Failed to fetch balance");
      const balanceData = await balanceRes.json();
      const holdings = (BigInt(balanceData.balance) / BigInt(1e18)).toString(); // Convert atomic to IRYS

      // Fetch transactions
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
        if (allTxs.length >= 5000) break;
      }

      const txCount = allTxs.length;
      let ageInDays = 0;
      let recencyFactor = 0;
      if (txCount > 0) {
        allTxs.sort((a, b) => a.timestamp - b.timestamp);
        const earliestTimestamp = allTxs[0].timestamp;
        const latestTimestamp = allTxs[allTxs.length - 1].timestamp;
        const currentTimestamp = new Date("July 12, 2025").getTime();
        ageInDays = Math.floor((currentTimestamp - earliestTimestamp) / (1000 * 60 * 60 * 24));
        if ((currentTimestamp - latestTimestamp) <= 7 * 24 * 60 * 60 * 1000) {
          recencyFactor = 0.5;
        }
      }

      // Calculate score
      const score = txCount * (1 + recencyFactor);

      res.status(200).json({ score, txCount, ageInDays, holdings });
    } else if (endpoint === 'leaderboard') {
      // Fetch recent transactions
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

      // Fetch balances and calculate scores for top wallets
      const currentTimestamp = new Date("July 12, 2025").getTime();
      const leaderboard = [];
      for (const address of Object.keys(walletData).slice(0, 50)) {
        const txCount = walletData[address].txCount;
        const latestTimestamp = walletData[address].latestTimestamp;
        const recencyFactor = (currentTimestamp - latestTimestamp) <= 7 * 24 * 60 * 60 * 1000 ? 0.5 : 0;
        const score = txCount * (1 + recencyFactor);

        const balanceRes = await fetch(`https://testnet.irys.xyz/account/balance/ethereum?address=${address}`);
        const balanceData = await balanceRes.ok ? await balanceRes.json() : { balance: "0" };
        const holdings = (BigInt(balanceData.balance) / BigInt(1e18)).toString();

        leaderboard.push({ address, score, txCount, holdings });
      }

      // Sort by score (desc), then txCount (desc), then holdings (desc)
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
    console.error("Error:", e);
    res.status(500).json({ error: "Failed to fetch data" });
  }
};
