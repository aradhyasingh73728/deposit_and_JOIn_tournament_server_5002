
/* ============================= LOAD ENV ============================= */
import dotenv from "dotenv";
dotenv.config();

/* ============================= IMPORTS ============================= */
import express from "express";
import cors from "cors";
import { nanoid } from "nanoid";
import { createClient } from "@supabase/supabase-js";
import { format } from "date-fns-tz";

/* ============================= APP ============================= */
const app = express();

/* ============================= ENV CHECK ============================= */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

/* ============================= SUPABASE ============================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

/* ============================= MIDDLEWARE ============================= */
app.use(cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

/* ============================= CACHE AND LOCKS ============================= */
const tournamentRooms = {};
const tournamentJoinLocks = new Map();

const ALLOWED_DEPOSIT_AMOUNTS = [
  50, 100, 200, 300, 400, 500, 1000, 5000,
];

const depositRequestTracker = new Map();
const DEPOSIT_RATE_LIMIT = 5;
const DEPOSIT_RATE_WINDOW_MS = 10 * 60 * 1000;

/* ============================= BASIC HELPERS ============================= */
const cleanString = (value) => String(value ?? "").trim();

const normalizeTime = (value) => {
  const time = cleanString(value);

  if (!time) return "";

  // HH:MM -> HH:MM:SS
  if (/^\d{2}:\d{2}$/.test(time)) return `${time}:00`;

  // HH:MM:SS
  if (/^\d{2}:\d{2}:\d{2}$/.test(time)) return time;

  // ISO timestamp or other parseable time
  const parsed = new Date(`1970-01-01T${time}`);

  if (!Number.isNaN(parsed.getTime())) {
    return `${String(parsed.getUTCHours()).padStart(2, "0")}:${String(
      parsed.getUTCMinutes()
    ).padStart(2, "0")}:${String(parsed.getUTCSeconds()).padStart(2, "0")}`;
  }

  return time;
};

const createMatchKey = (tournamentId, date, time) => {
  const id = cleanString(tournamentId);
  const matchDate = cleanString(date);
  const matchTime = normalizeTime(time);

  if (!id || !matchDate || !matchTime) return "";

  return `${id}|${matchDate}|${matchTime}`;
};

const getMatchDetails = (source = {}) => {
  const tournamentId = cleanString(source.tournamentId);
  const date = cleanString(source.date);
  const time = normalizeTime(source.time);

  return {
    tournamentId,
    date,
    time,
    matchKey: createMatchKey(tournamentId, date, time),
  };
};

const runWithTournamentJoinLock = async (matchKey, task) => {
  const previous = tournamentJoinLocks.get(matchKey) || Promise.resolve();

  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });

  const queue = previous.then(() => current);
  tournamentJoinLocks.set(matchKey, queue);

  try {
    await previous;
    return await task();
  } finally {
    releaseCurrent();

    if (tournamentJoinLocks.get(matchKey) === queue) {
      tournamentJoinLocks.delete(matchKey);
    }
  }
};

/* ============================= DATABASE TOURNAMENT CONFIG ============================= */

const getTournamentConfig = async (tournamentId) => {
  const id = cleanString(tournamentId);

  if (!id) {
    return { success: false, message: "Tournament ID required" };
  }

  const { data, error } = await supabase
    .from("create_tournament")
    .select(`
      tournament_id,
      tournament_name,
      game_mode,
      match_type,
      map,
      date,
      time,
      entry_fee,
      prize_pool,
      per_kill,
      slots,
      rules,
      image_url,
      status,
      published,
      tournament_status
    `)
    .eq("tournament_id", id)
    .maybeSingle();

  if (error) {
    console.error("TOURNAMENT CONFIG ERROR:", error);
    return { success: false, message: "Could not load tournament configuration" };
  }

  if (!data) {
    return { success: false, message: "Tournament not found" };
  }

  if (data.published !== true) {
    return { success: false, message: "Tournament is not published" };
  }

  const status = cleanString(data.tournament_status).toLowerCase();

  if (status === "cancelled" || status === "completed") {
    return { success: false, message: "This tournament is not available" };
  }

  const entryFee = Number(data.entry_fee);
  const slots = Number(data.slots);
  const prizePool = Number(data.prize_pool ?? 0);
  const perKill = Number(data.per_kill ?? 0);

  if (!Number.isFinite(entryFee) || entryFee < 0) {
    return { success: false, message: "Invalid tournament entry fee" };
  }

  if (!Number.isInteger(slots) || slots < 1) {
    return { success: false, message: "Invalid tournament slots" };
  }

  if (!Number.isFinite(prizePool) || prizePool < 0) {
    return { success: false, message: "Invalid prize pool" };
  }

  if (!Number.isFinite(perKill) || perKill < 0) {
    return { success: false, message: "Invalid per-kill amount" };
  }

  if (!data.date || !data.time) {
    return { success: false, message: "Tournament date and time are required" };
  }

  return {
    success: true,
    tournament: {
      ...data,
      entry_fee: entryFee,
      slots,
      prize_pool: prizePool,
      per_kill: perKill,
      time: normalizeTime(data.time),
      date: String(data.date),
    },
  };
};

/* ============================= DEPOSIT RATE LIMIT ============================= */
const checkDepositRateLimit = (profileId) => {
  const now = Date.now();
  const existing = depositRequestTracker.get(profileId);

  if (!existing || now - existing.firstRequest > DEPOSIT_RATE_WINDOW_MS) {
    depositRequestTracker.set(profileId, {
      count: 1,
      firstRequest: now,
    });
    return { allowed: true };
  }

  if (existing.count >= DEPOSIT_RATE_LIMIT) {
    return { allowed: false };
  }

  existing.count += 1;
  return { allowed: true };
};

/* ============================= UNIQUE DEPOSIT ID ============================= */
const generateUniqueDepositId = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const depositId = nanoid(6);

    const { data, error } = await supabase
      .from("DepositUser")
      .select("id")
      .eq("deposit_id", depositId)
      .maybeSingle();

    if (error) {
      console.error("DEPOSIT ID CHECK ERROR:", error);
      throw new Error("Could not generate Deposit ID");
    }

    if (!data) return depositId;
  }

  throw new Error("Could not generate unique Deposit ID");
};

/* ============================= RESOLVE PROFILE FROM BGMI ============================= */
const resolveProfileFromBgmi = async (bgmiId) => {
  const cleanBgmiId = cleanString(bgmiId);

  if (!cleanBgmiId) {
    return { profileId: "", error: "bgmiId required" };
  }

  const { data, error } = await supabase
    .from("tournament_joins")
    .select("profile_id")
    .eq("bgmi_id", cleanBgmiId);

  if (error) {
    console.error("PROFILE RESOLVE ERROR:", error);
    return { profileId: "", error: error.message };
  }

  const uniqueProfiles = [
    ...new Set((data || [])
      .map((row) => cleanString(row.profile_id))
      .filter(Boolean)),
  ];

  if (uniqueProfiles.length === 1) {
    return { profileId: uniqueProfiles[0], error: "" };
  }

  if (uniqueProfiles.length > 1) {
    return {
      profileId: "",
      error: "This BGMI ID is used by multiple accounts. profileId is required.",
    };
  }

  return {
    profileId: "",
    error: "Profile could not be identified. profileId is required.",
  };
};

/* ============================= GET USER BALANCE ============================= */
const getUserBalance = async (profileId) => {
  const id = cleanString(profileId);

  if (!id) {
    return { success: false, message: "profileId required", balance: null };
  }

  const { data, error } = await supabase
    .from("registeruser")
    .select("profile_id, balance")
    .eq("profile_id", id)
    .single();

  if (error || !data) {
    return { success: false, message: "User account not found", balance: null };
  }

  const balance = Number(data.balance || 0);

  if (!Number.isFinite(balance)) {
    return { success: false, message: "Invalid wallet balance", balance: null };
  }

  return { success: true, balance, profileId: data.profile_id };
};

/* ============================= GET USER ACCOUNT ============================= */
const getUserAccount = async (profileId) => {
  const id = cleanString(profileId);

  if (!id) return { success: false, message: "profileId required" };

  const { data, error } = await supabase
    .from("registeruser")
    .select("profile_id, username, email, verified")
    .eq("profile_id", id)
    .single();

  if (error || !data) {
    return { success: false, message: "User account not found" };
  }

  return { success: true, user: data };
};

/* ============================= DEDUCT ENTRY FEE ============================= */
const deductTournamentEntryFee = async (profileId, amount) => {
  const entryFee = Number(amount);

  if (!Number.isFinite(entryFee) || entryFee < 0) {
    return { success: false, message: "Invalid entry fee" };
  }

  const balanceResult = await getUserBalance(profileId);
  if (!balanceResult.success) return balanceResult;

  const currentBalance = balanceResult.balance;

  if (currentBalance < entryFee) {
    return {
      success: false,
      message: `Insufficient balance. Required ₹${entryFee}, available ₹${currentBalance}.`,
      currentBalance,
      requiredAmount: entryFee,
    };
  }

  if (entryFee === 0) {
    return {
      success: true,
      deducted: 0,
      previousBalance: currentBalance,
      newBalance: currentBalance,
    };
  }

  const newBalance = currentBalance - entryFee;

  const { data, error } = await supabase
    .from("registeruser")
    .update({ balance: newBalance })
    .eq("profile_id", profileId)
    .eq("balance", currentBalance)
    .select("profile_id, balance")
    .maybeSingle();

  if (error || !data) {
    console.error("WALLET DEDUCTION ERROR:", error);
    return {
      success: false,
      message: "Wallet changed during transaction. Please try again.",
    };
  }

  return {
    success: true,
    deducted: entryFee,
    previousBalance: currentBalance,
    newBalance,
  };
};

/* ============================= REFUND ENTRY FEE ============================= */
const refundTournamentEntryFee = async (profileId, amount) => {
  const refundAmount = Number(amount);

  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    return { success: true, refunded: 0 };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const balanceResult = await getUserBalance(profileId);

    if (!balanceResult.success) {
      return {
        success: false,
        refunded: 0,
        message: "Could not fetch balance for refund",
      };
    }

    const currentBalance = balanceResult.balance;
    const newBalance = currentBalance + refundAmount;

    const { data, error } = await supabase
      .from("registeruser")
      .update({ balance: newBalance })
      .eq("profile_id", profileId)
      .eq("balance", currentBalance)
      .select("profile_id, balance")
      .maybeSingle();

    if (error) {
      return { success: false, refunded: 0, message: error.message };
    }

    if (data) {
      return {
        success: true,
        refunded: refundAmount,
        previousBalance: currentBalance,
        newBalance,
      };
    }
  }

  return {
    success: false,
    refunded: 0,
    message: "Wallet refund could not be completed automatically",
  };
};

/* ============================= HEALTH ============================= */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    supabase: "Configured",
    tournamentConfig: "DATABASE DYNAMIC",
    matchWiseDuplicateProtection: "ACTIVE",
    walletDeduction: "ACTIVE",
    rollback: "ACTIVE",
    deposits: "ACTIVE",
  });
});

/* ============================= MY BALANCE ============================= */
app.get("/api/my-balance", async (req, res) => {
  try {
    const profileId = cleanString(req.query.profileId);

    if (!profileId) return res.json({ balance: 0 });

    const result = await getUserBalance(profileId);

    return res.json({
      balance: result.success ? result.balance : 0,
    });
  } catch (err) {
    console.error("BALANCE ERROR:", err);
    return res.json({ balance: 0 });
  }
});

/* ============================= CLEAR APPROVED DEPOSITS ============================= */
app.delete("/api/admin/clear-approved/:profileId", async (req, res) => {
  try {
    const profileId = cleanString(req.params.profileId);

    if (!profileId) {
      return res.status(400).json({
        success: false,
        message: "profileId required",
      });
    }

    const { data, error } = await supabase
      .from("DepositUser")
      .delete()
      .eq("profile_id", profileId)
      .eq("status", "approved")
      .select("amount, date_ist");

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({
      success: true,
      cleared: data?.length || 0,
      message: "Approved history cleared. Wallet unchanged.",
    });
  } catch (err) {
    console.error("CLEAR APPROVED ERROR:", err);
    return res.status(500).json({ success: false, message: "Clear failed" });
  }
});

/* ============================= ROLLBACK JOIN ============================= */
app.post("/api/rollback-join/:tournamentId", async (req, res) => {
  try {
    const tournamentId = cleanString(req.params.tournamentId);
    const profileId = cleanString(req.query.profileId);
    const bgmiId = cleanString(req.query.bgmiId);
    const { date, time, matchKey } = getMatchDetails({
      tournamentId,
      date: req.query.date,
      time: req.query.time,
    });

    if (!matchKey) {
      return res.status(400).json({
        success: false,
        message: "tournamentId, date and time required",
      });
    }

    if (profileId) {
      const { data, error } = await supabase
        .from("tournament_joins")
        .delete()
        .eq("match_key", matchKey)
        .eq("profile_id", profileId)
        .select("id");

      if (error) {
        return res.status(500).json({ success: false, message: error.message });
      }

      return res.json({
        success: true,
        deleted: data?.length || 0,
        matchKey,
      });
    }

    if (!bgmiId) {
      return res.status(400).json({
        success: false,
        message: "profileId or bgmiId required",
      });
    }

    const { data: rows, error } = await supabase
      .from("tournament_joins")
      .select("id")
      .eq("match_key", matchKey)
      .eq("bgmi_id", bgmiId);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!rows?.length) {
      return res.json({ success: true, deleted: 0 });
    }

    if (rows.length > 1) {
      return res.status(409).json({
        success: false,
        message: "Multiple accounts use this BGMI ID. profileId required.",
      });
    }

    const { error: deleteError } = await supabase
      .from("tournament_joins")
      .delete()
      .eq("id", rows[0].id)
      .eq("match_key", matchKey);

    if (deleteError) {
      return res.status(500).json({
        success: false,
        message: deleteError.message,
      });
    }

    return res.json({ success: true, deleted: 1, matchKey });
  } catch (err) {
    console.error("ROLLBACK ERROR:", err);
    return res.status(500).json({ success: false, message: "Rollback failed" });
  }
});

/* ============================= JOIN TOURNAMENT - DYNAMIC ============================= */
app.post("/api/join-tournament", async (req, res) => {
  const data = req.body || {};

  const tournamentId = cleanString(data.tournamentId);
  const bgmiId = cleanString(data.bgmiId);
  const playerName = cleanString(data.playerName);
  const profileId = cleanString(data.profileId);
  const profileName = cleanString(data.profileName);
  const requestedDate = cleanString(data.date);
  const requestedTime = normalizeTime(data.time);

  if (!tournamentId || !bgmiId || !playerName || !profileId) {
    return res.status(400).json({
      success: false,
      message: "tournamentId, bgmiId, playerName and profileId are required",
    });
  }

  try {
    const configResult = await getTournamentConfig(tournamentId);

    if (!configResult.success) {
      return res.status(400).json({
        success: false,
        message: configResult.message,
      });
    }

    const tournament = configResult.tournament;

    if (
      requestedDate !== tournament.date ||
      requestedTime !== tournament.time
    ) {
      return res.status(409).json({
        success: false,
        message: "Tournament date or time has changed. Refresh and try again.",
        date: tournament.date,
        time: tournament.time,
      });
    }

    const matchKey = createMatchKey(
      tournamentId,
      tournament.date,
      tournament.time
    );

    return await runWithTournamentJoinLock(matchKey, async () => {
      const account = await getUserAccount(profileId);

      if (!account.success) {
        return res.status(404).json({
          success: false,
          message: account.message,
        });
      }

      const dbUser = account.user;

      if (dbUser.verified === false) {
        return res.status(403).json({
          success: false,
          message: "Please verify your account first",
        });
      }

      const { data: existingJoin, error: existingError } = await supabase
        .from("tournament_joins")
        .select("id")
        .eq("match_key", matchKey)
        .eq("profile_id", profileId)
        .maybeSingle();

      if (existingError) {
        return res.status(500).json({
          success: false,
          message: existingError.message,
        });
      }

      if (existingJoin) {
        return res.json({
          success: false,
          alreadyJoined: true,
          message: "Already joined this match!",
        });
      }

      const { count, error: countError } = await supabase
        .from("tournament_joins")
        .select("*", { count: "exact", head: true })
        .eq("match_key", matchKey);

      if (countError) {
        return res.status(500).json({
          success: false,
          message: countError.message,
        });
      }

      if ((count || 0) >= tournament.slots) {
        return res.status(409).json({
          success: false,
          message: `Tournament Full (${count || 0}/${tournament.slots} slots)`,
        });
      }

      const balanceBefore = await getUserBalance(profileId);

      if (!balanceBefore.success) {
        return res.status(404).json({
          success: false,
          message: balanceBefore.message,
        });
      }

      const deduction = await deductTournamentEntryFee(
        profileId,
        tournament.entry_fee
      );

      if (!deduction.success) {
        return res.status(400).json({
          success: false,
          insufficientBalance: String(deduction.message || "")
            .toLowerCase()
            .includes("insufficient"),
          message: deduction.message,
          balance: deduction.currentBalance ?? balanceBefore.balance,
        });
      }

      const cleanData = {
        tournament_id: tournament.tournament_id,
        match_key: matchKey,
        tournament_name: tournament.tournament_name,
        player_name: playerName,
        bgmi_id: bgmiId,
        profile_name: cleanString(dbUser.username) || profileName || playerName,
        profile_id: profileId,
        mode: cleanString(tournament.game_mode) || "TDM",
        rules: cleanString(tournament.rules),
        date: tournament.date,
        time: tournament.time,
        map: cleanString(tournament.map) || "Erangel",
        entry_fee: tournament.entry_fee,
        prize_pool: tournament.prize_pool,
        slots: tournament.slots,
        status: "Registered",
        joined_at: new Date().toISOString(),
        room_id: "",
        room_password: "",
      };

      const { data: newJoin, error } = await supabase
        .from("tournament_joins")
        .insert([cleanData])
        .select()
        .single();

      if (error) {
        console.error("JOIN INSERT ERROR:", error);

        const refund = await refundTournamentEntryFee(
          profileId,
          tournament.entry_fee
        );

        if (!refund.success) {
          console.error("CRITICAL JOIN + REFUND FAILURE:", {
            profileId,
            matchKey,
            entryFee: tournament.entry_fee,
            refundError: refund.message,
          });
        }

        if (error.code === "23505") {
          return res.status(409).json({
            success: false,
            alreadyJoined: true,
            refunded: refund.success,
            message: "Already joined this match!",
          });
        }

        return res.status(500).json({
          success: false,
          message: "Tournament join could not be completed",
          refunded: refund.success,
        });
      }

      return res.json({
        success: true,
        alreadyJoined: false,
        joinId: newJoin.id,
        matchKey,
        entryFee: tournament.entry_fee,
        slots: tournament.slots,
        previousBalance: deduction.previousBalance,
        newBalance: deduction.newBalance,
        message: "Successfully joined tournament match!",
      });
    });
  } catch (err) {
    console.error("JOIN SERVER ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* ============================= CHECK JOIN ============================= */
app.get("/api/check-join/:tournamentId", async (req, res) => {
  try {
    const tournamentId = cleanString(req.params.tournamentId);
    const profileId = cleanString(req.query.profileId);
    const bgmiId = cleanString(req.query.bgmiId);

    const { matchKey } = getMatchDetails({
      tournamentId,
      date: req.query.date,
      time: req.query.time,
    });

    if (!matchKey) {
      return res.status(400).json({
        joined: false,
        message: "tournamentId, date and time are required",
      });
    }

    let targetProfileId = profileId;

    if (!targetProfileId && bgmiId) {
      const resolved = await resolveProfileFromBgmi(bgmiId);

      if (!resolved.profileId) {
        return res.status(409).json({
          joined: false,
          message: resolved.error,
        });
      }

      targetProfileId = resolved.profileId;
    }

    if (!targetProfileId) {
      return res.status(400).json({
        joined: false,
        message: "profileId required",
      });
    }

    const { data, error } = await supabase
      .from("tournament_joins")
      .select("id")
      .eq("match_key", matchKey)
      .eq("profile_id", targetProfileId)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ joined: false, message: error.message });
    }

    return res.json({ joined: !!data, matchKey });
  } catch (err) {
    console.error("CHECK JOIN ERROR:", err);
    return res.status(500).json({ joined: false });
  }
});

/* ============================= SLOT COUNT - DYNAMIC ============================= */
app.get("/api/tournament-slots-count/:tournamentId", async (req, res) => {
  try {
    const tournamentId = cleanString(req.params.tournamentId);

    const configResult = await getTournamentConfig(tournamentId);

    if (!configResult.success) {
      return res.status(400).json({
        success: false,
        message: configResult.message,
        registered: 0,
        max: 0,
      });
    }

    const tournament = configResult.tournament;

    const { matchKey } = getMatchDetails({
      tournamentId,
      date: req.query.date,
      time: req.query.time,
    });

    const expectedKey = createMatchKey(
      tournamentId,
      tournament.date,
      tournament.time
    );

    if (!matchKey || matchKey !== expectedKey) {
      return res.status(409).json({
        success: false,
        message: "Tournament date or time mismatch",
        registered: 0,
        max: tournament.slots,
      });
    }

    const { count, error } = await supabase
      .from("tournament_joins")
      .select("*", { count: "exact", head: true })
      .eq("match_key", matchKey);

    if (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
        registered: 0,
        max: tournament.slots,
      });
    }

    return res.json({
      success: true,
      matchKey,
      registered: count || 0,
      max: tournament.slots,
      remaining: Math.max(0, tournament.slots - (count || 0)),
    });
  } catch (err) {
    console.error("SLOTS ERROR:", err);
    return res.status(500).json({
      success: false,
      registered: 0,
      max: 0,
    });
  }
});

/* ============================= MY MATCHES ============================= */

/* ============================= MY MATCHES ============================= */
app.get("/api/my-matches", async (req, res) => {
  try {
    let profileId = cleanString(req.query.profileId);
    const bgmiId = cleanString(req.query.bgmiId);

    if (!profileId && bgmiId) {
      const resolved = await resolveProfileFromBgmi(bgmiId);

      if (!resolved.profileId) {
        return res.status(409).json({
          success: false,
          message: resolved.error,
          matches: [],
        });
      }

      profileId = resolved.profileId;
    }

    if (!profileId) {
      return res.status(400).json({
        success: false,
        message: "profileId required",
        matches: [],
      });
    }

    // STEP 1: Fetch player's joined tournaments
    const { data, error } = await supabase
      .from("tournament_joins")
      .select("*")
      .eq("profile_id", profileId)
      .order("joined_at", { ascending: false });

    if (error) {
      console.error("MY MATCHES FETCH ERROR:", error);

      return res.status(500).json({
        success: false,
        message: error.message,
        matches: [],
      });
    }

    const joinedMatches = data || [];

    // No joined tournaments
    if (joinedMatches.length === 0) {
      return res.json({
        success: true,
        profileId,
        matches: [],
      });
    }

    // STEP 2: Get unique tournament IDs
    const tournamentIds = [
      ...new Set(
        joinedMatches
          .map((match) => cleanString(match.tournament_id))
          .filter(Boolean)
      ),
    ];

    // STEP 3: Fetch current tournament statuses
    const { data: tournamentData, error: statusError } =
      await supabase
        .from("create_tournament")
        .select("tournament_id, status, tournament_status")
        .in("tournament_id", tournamentIds);

    if (statusError) {
      console.error("MY MATCHES STATUS ERROR:", statusError);

      return res.status(500).json({
        success: false,
        message: "Could not verify tournament statuses.",
        matches: [],
      });
    }

    // STEP 4: Identify completed tournaments
    const completedTournamentIds = new Set(
      (tournamentData || [])
        .filter((tournament) => {
          const status = cleanString(
            tournament.status
          ).toLowerCase();

          const tournamentStatus = cleanString(
            tournament.tournament_status
          ).toLowerCase();

          return (
            status === "completed" ||
            tournamentStatus === "completed"
          );
        })
        .map((tournament) =>
          cleanString(tournament.tournament_id)
        )
    );

    // STEP 5: Remove completed tournaments from My Matches
    const activeMatches = joinedMatches.filter(
      (match) =>
        !completedTournamentIds.has(
          cleanString(match.tournament_id)
        )
    );

    // STEP 6: Add room details
    const matches = activeMatches.map((match) => {
      const cachedRoom =
        tournamentRooms[match.match_key] || {};

      return {
        ...match,
        roomId:
          match.room_id ||
          cachedRoom.roomId ||
          "",
        roomPassword:
          match.room_password ||
          cachedRoom.roomPassword ||
          "",
      };
    });

    return res.json({
      success: true,
      profileId,
      matches,
      totalMatches: matches.length,
      hiddenCompleted: completedTournamentIds.size,
    });

  } catch (err) {
    console.error("MY MATCHES ERROR:", err);

    return res.status(500).json({
      success: false,
      message: "Could not load My Matches.",
      matches: [],
    });
  }
});


/* ============================= ADMIN JOINS ============================= */
app.get("/api/admin/joins", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tournament_joins")
      .select("*")
      .order("joined_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        tournamentJoins: [],
        message: error.message,
      });
    }

    const synced = (data || []).map((join) => {
      const cachedRoom = tournamentRooms[join.match_key] || {};

      return {
        ...join,
        room_id: join.room_id || cachedRoom.roomId || "",
        room_password: join.room_password || cachedRoom.roomPassword || "",
      };
    });

    return res.json({ tournamentJoins: synced });
  } catch (err) {
    console.error("ADMIN JOINS ERROR:", err);
    return res.status(500).json({ tournamentJoins: [] });
  }
});

/* ============================= SAVE ROOM ============================= */
app.put("/api/admin/set-room-by-tournament", async (req, res) => {
  const tournamentId = cleanString(req.body?.tournamentId);
  const date = cleanString(req.body?.date);
  const time = normalizeTime(req.body?.time);
  const roomId = cleanString(req.body?.roomId);
  const roomPassword = cleanString(req.body?.roomPassword);

  const matchKey = createMatchKey(tournamentId, date, time);

  if (!matchKey) {
    return res.status(400).json({
      success: false,
      message: "tournamentId, date and time are required",
    });
  }

  try {
    const { data, error } = await supabase
      .from("tournament_joins")
      .update({
        room_id: roomId,
        room_password: roomPassword,
      })
      .eq("match_key", matchKey)
      .select("id");

    if (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    tournamentRooms[matchKey] = { roomId, roomPassword };

    return res.json({
      success: true,
      matchKey,
      updated: data?.length || 0,
      roomId,
      roomPassword,
      message: "Room saved for this match!",
    });
  } catch (err) {
    console.error("ROOM SAVE ERROR:", err);
    return res.status(500).json({ success: false, message: "Save failed" });
  }
});



/* ============================= DELETE / CANCEL TOURNAMENT WITH REFUND ============================= */

const refundAndDeleteTournament = async (req, res) => {
  try {
    const tournamentId = cleanString(req.params.tournamentId);

    if (!tournamentId) {
      return res.status(400).json({
        success: false,
        message: "Tournament ID required",
      });
    }

    const { data, error } = await supabase.rpc(
      "admin_refund_and_delete_tournament",
      {
        p_tournament_id: tournamentId,
      }
    );

    if (error) {
      console.error("TOURNAMENT REFUND DELETE ERROR:", error);

      return res.status(400).json({
        success: false,
        message: error.message || "Tournament refund and deletion failed",
      });
    }

    return res.json({
      success: true,
      message: "Tournament deleted and player entry fees refunded successfully.",
      result: data,
    });

  } catch (err) {
    console.error("TOURNAMENT DELETE SERVER ERROR:", err);

    return res.status(500).json({
      success: false,
      message: "Server error during tournament deletion",
    });
  }
};


// Admin: permanently delete tournament with refunds
app.delete(
  "/api/admin/tournaments/:tournamentId",
  refundAndDeleteTournament
);


// Admin: cancel tournament, refund players and remove tournament data
app.post(
  "/api/admin/tournaments/:tournamentId/cancel",
  refundAndDeleteTournament
);





/* ============================= DELETE JOIN ============================= */
app.delete("/api/admin/tournament/:id", async (req, res) => {
  try {
    const joinId = cleanString(req.params.id);

    if (!joinId) {
      return res.status(400).json({
        success: false,
        message: "Join ID required",
      });
    }

    const { data, error } = await supabase
      .from("tournament_joins")
      .delete()
      .eq("id", joinId)
      .select("id, tournament_id, profile_id, match_key");

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({
      success: true,
      deleted: data?.length || 0,
    });
  } catch (err) {
    console.error("DELETE JOIN ERROR:", err);
    return res.status(500).json({ success: false });
  }
});

/* ============================= CREATE DEPOSIT ============================= */
app.post("/api/deposit", async (req, res) => {
  const profileId = cleanString(req.body?.profileId);
  const amount = Number(req.body?.amount);
  const utr = cleanString(req.body?.utr);

  if (!profileId || !utr) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields",
    });
  }

  if (profileId.length < 3 || profileId.length > 100) {
    return res.status(400).json({
      success: false,
      message: "Invalid profileId",
    });
  }

  if (!Number.isInteger(amount) || !ALLOWED_DEPOSIT_AMOUNTS.includes(amount)) {
    return res.status(400).json({
      success: false,
      message: "Invalid deposit amount",
    });
  }

  if (!/^\d{12}$/.test(utr)) {
    return res.status(400).json({
      success: false,
      message: "UTR must contain exactly 12 digits",
    });
  }

  if (!checkDepositRateLimit(profileId).allowed) {
    return res.status(429).json({
      success: false,
      message: "Too many deposit requests. Please try again later.",
    });
  }

  try {
    const account = await getUserAccount(profileId);

    if (!account.success) {
      return res.status(404).json({
        success: false,
        message: account.message,
      });
    }

    const user = account.user;

    if (user.verified === false) {
      return res.status(403).json({
        success: false,
        message: "Please verify your account first",
      });
    }

    const { data: existingUtr, error: utrError } = await supabase
      .from("DepositUser")
      .select("id, profile_id, status")
      .eq("utr", utr)
      .maybeSingle();

    if (utrError) {
      return res.status(500).json({
        success: false,
        message: "Could not verify UTR",
      });
    }

    if (existingUtr) {
      return res.status(409).json({
        success: false,
        message: "This UTR has already been submitted",
      });
    }

    const nowUTC = new Date().toISOString();

    const nowIST = format(
      new Date(),
      "dd/MM/yyyy, hh:mm:ss a",
      { timeZone: "Asia/Kolkata" }
    );

    const depositId = await generateUniqueDepositId();

    const { data, error } = await supabase
      .from("DepositUser")
      .insert([{
        deposit_id: depositId,
        profile_id: user.profile_id,
        name: cleanString(user.username) || "Unknown",
        email: cleanString(user.email) || "no-email",
        amount,
        utr,
        status: "pending",
        date: nowUTC,
        date_ist: nowIST,
      }])
      .select()
      .single();

    if (error) {
      console.error("DEPOSIT INSERT ERROR:", error);

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This deposit or UTR already exists",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Deposit request could not be created",
      });
    }

    return res.json({
      success: true,
      deposit: {
        id: data.id,
        deposit_id: data.deposit_id,
        amount: data.amount,
        status: data.status,
        date: data.date,
        date_ist: data.date_ist,
      },
      message: "Deposit request submitted successfully",
    });
  } catch (err) {
    console.error("DEPOSIT ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

/* ============================= APPROVE / REJECT DEPOSIT ============================= */
app.put("/api/admin/deposit-status/:id", async (req, res) => {
  const status = cleanString(req.body?.status).toLowerCase();

  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid deposit status",
    });
  }

  try {
    const { data: deposit, error: depositError } = await supabase
      .from("DepositUser")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (depositError || !deposit) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found",
      });
    }

    if (status === "approved" && deposit.status === "pending") {
      const { data: user, error: userError } = await supabase
        .from("registeruser")
        .select("balance")
        .eq("profile_id", deposit.profile_id)
        .single();

      if (userError || !user) {
        return res.status(404).json({
          success: false,
          message: "User fetch failed",
        });
      }

      const currentBalance = Number(user.balance || 0);
      const depositAmount = Number(deposit.amount || 0);

      if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid deposit amount",
        });
      }

      const newBalance = currentBalance + depositAmount;

      const { data: updatedUser, error: balanceError } = await supabase
        .from("registeruser")
        .update({ balance: newBalance })
        .eq("profile_id", deposit.profile_id)
        .eq("balance", currentBalance)
        .select("profile_id, balance")
        .maybeSingle();

      if (balanceError) {
        return res.status(500).json({
          success: false,
          message: "Balance update failed",
        });
      }

      if (!updatedUser) {
        return res.status(409).json({
          success: false,
          message: "Wallet changed during approval. Please try again.",
        });
      }
    }

    const { data: updatedDeposit, error: statusError } = await supabase
      .from("DepositUser")
      .update({ status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (statusError) {
      return res.status(500).json({
        success: false,
        message: "Deposit status update failed",
      });
    }

    return res.json({
      success: true,
      deposit: updatedDeposit,
    });
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* ============================= DELETE DEPOSIT ============================= */
app.delete("/api/admin/deposit/:id", async (req, res) => {
  try {
    const { data: deposit } = await supabase
      .from("DepositUser")
      .select("profile_id, status, amount")
      .eq("id", req.params.id)
      .single();

    const { error } = await supabase
      .from("DepositUser")
      .delete()
      .eq("id", req.params.id);

    if (error) {
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE DEPOSIT ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/* ============================= USER DEPOSITS ============================= */
app.get("/api/deposits", async (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  try {
    const profileId = cleanString(req.query.profileId);

    if (!profileId || profileId.length < 3 || profileId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Valid profileId required",
        deposits: [],
      });
    }

    const { data, error } = await supabase
      .from("DepositUser")
      .select("*")
      .eq("profile_id", profileId)
      .order("date", { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Could not load deposit history",
        deposits: [],
      });
    }

    return res.json({
      success: true,
      profileId,
      deposits: data || [],
    });
  } catch (err) {
    console.error("GET DEPOSITS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      deposits: [],
    });
  }
});

/* ============================= ADMIN DEPOSITS ============================= */
app.get("/api/admin/deposits", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("DepositUser")
      .select("*")
      .order("date", { ascending: false });

    if (error) {
      return res.status(500).json({ deposits: [] });
    }

    return res.json({ deposits: data || [] });
  } catch (err) {
    console.error("ADMIN DEPOSITS ERROR:", err);
    return res.status(500).json({ deposits: [] });
  }
});

/* ============================= SERVER START ============================= */
const PORT = process.env.PORT || 5002;

app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================");
  console.log("BGMI SERVER RUNNING ON PORT", PORT);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log("Tournament configuration: DATABASE DYNAMIC");
  console.log("Entry fee: FROM create_tournament");
  console.log("Slots: FROM create_tournament");
  console.log("Date/time: DATABASE VALIDATED");
  console.log("Match key: NORMALIZED HH:MM:SS");
  console.log("Wallet deduction: ACTIVE");
  console.log("Failed join refund: ACTIVE");
  console.log("Deposit APIs: ACTIVE");
  console.log("My Matches: PROFILE FILTER");
  console.log("Room storage: SUPABASE");
  console.log("======================================");
});
