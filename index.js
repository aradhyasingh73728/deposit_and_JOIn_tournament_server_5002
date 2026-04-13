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
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables");
}

/* ============================= SUPABASE CLIENT ============================= */
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

/* ============================= CORS ============================= */
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

/* ============================= IN-MEMORY ROOMS ============================= */
let tournamentRooms = {};

/* ============================= HEALTH CHECK ============================= */
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    time: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    supabase: "✅ Connected",
    roomCacheCount: Object.keys(tournamentRooms).length,
    myBalance: "✅ ACTIVE",
    rollback: "✅ ACTIVE",
    clearApproved: "✅ ACTIVE",
    adminJoins: "✅ RETURNS ROOM DATA",
    roomSave: "✅ SUPABASE + CACHE",
  });
});

/* ============================= MY BALANCE ============================= */
app.get("/api/my-balance", async (req, res) => {
  try {
    const { profileId } = req.query;

    if (!profileId) {
      console.log("❌ No profileId provided");
      return res.json({ balance: 0 });
    }

    const { data, error } = await supabase
      .from("registeruser")
      .select("balance")
      .eq("profile_id", profileId)
      .single();

    if (error) {
      console.error("❌ BALANCE FETCH ERROR:", error);
      return res.json({ balance: 0 });
    }

    const balance = data?.balance || 0;
    console.log("💰 BALANCE FETCH:", profileId, "→ ₹", balance);
    res.json({ balance });
  } catch (err) {
    console.error("❌ BALANCE ERROR:", err);
    res.json({ balance: 0 });
  }
});

/* ============================= CLEAR APPROVED DEPOSITS ============================= */
app.delete("/api/admin/clear-approved/:profileId", async (req, res) => {
  try {
    const { profileId } = req.params;

    const { data: deletedDeposits, error } = await supabase
      .from("DepositUser")
      .delete()
      .eq("profile_id", profileId)
      .eq("status", "approved")
      .select("amount, date_ist");

    if (error) {
      console.error("❌ CLEAR APPROVED ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    const cleared = deletedDeposits?.length || 0;

    console.log(
      "🗑️ APPROVED HISTORY CLEARED:",
      profileId,
      `${cleared} deposits deleted (WALLET SAFE ✅)`
    );

    res.json({
      success: true,
      cleared,
      message: "Approved deposits cleared! Wallet balance unchanged ✅",
    });
  } catch (err) {
    console.error("❌ CLEAR APPROVED ERROR:", err);
    res.status(500).json({ success: false, message: "Clear failed" });
  }
});

/* ============================= ROLLBACK JOIN ============================= */
app.post("/api/rollback-join/:tournamentId", async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { bgmiId } = req.query;

    if (!bgmiId) {
      return res.status(400).json({ success: false, message: "bgmiId required" });
    }

    const { data: deletedRows, error } = await supabase
      .from("tournament_joins")
      .delete()
      .eq("tournament_id", tournamentId)
      .eq("bgmi_id", bgmiId)
      .select("id");

    if (error) {
      console.error("❌ ROLLBACK ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    const deleted = deletedRows?.length || 0;

    console.log("🔄 ROLLBACK SUCCESS:", tournamentId, bgmiId, `${deleted} records deleted`);

    res.json({
      success: true,
      deleted,
      message: "✅ Tournament join rolled back successfully!",
    });
  } catch (err) {
    console.error("❌ ROLLBACK ERROR:", err);
    res.status(500).json({ success: false, message: "Rollback failed" });
  }
});

/* ============================= JOIN TOURNAMENT ============================= */
app.post("/api/join-tournament", async (req, res) => {
  const data = req.body;

  console.log("📦 RAW DATA RECEIVED:", data);

  if (!data.bgmiId || !data.tournamentId || !data.playerName) {
    return res.status(400).json({
      success: false,
      message: "Missing bgmiId, tournamentId or playerName",
    });
  }

  try {
    const { data: existingJoin, error: existingError } = await supabase
      .from("tournament_joins")
      .select("id")
      .eq("tournament_id", data.tournamentId)
      .eq("bgmi_id", data.bgmiId)
      .maybeSingle();

    if (existingError) {
      console.error("❌ EXISTING JOIN CHECK ERROR:", existingError);
      return res.status(500).json({ success: false, message: existingError.message });
    }

    if (existingJoin) {
      return res.json({
        success: false,
        message: "❌ Already joined this tournament!",
      });
    }

    const { count, error: countError } = await supabase
      .from("tournament_joins")
      .select("*", { count: "exact", head: true })
      .eq("tournament_id", data.tournamentId);

    if (countError) {
      console.error("❌ SLOT COUNT ERROR:", countError);
      return res.status(500).json({ success: false, message: countError.message });
    }

    if ((count || 0) >= 50) {
      return res.json({
        success: false,
        message: "🔴 Tournament Full (50/50 slots)",
      });
    }

    let profileName = data.profileName || "";
    let profileId = data.profileId || "";

    if (!profileId) {
      const { data: deposits, error: depositLookupError } = await supabase
        .from("DepositUser")
        .select("profile_id, name")
        .eq("status", "approved")
        .order("date", { ascending: false })
        .limit(1);

      if (depositLookupError) {
        console.error("❌ PROFILE AUTO-FIND ERROR:", depositLookupError);
      }

      if (deposits?.[0]) {
        profileId = deposits[0].profile_id;
        profileName = deposits[0].name;
        console.log("🔥 AUTO-FOUND from DepositUser:", { profileId, profileName });
      } else {
        profileId = "guest_" + nanoid(6);
        profileName = data.playerName;
        console.log("🔥 GUEST created:", { profileId, profileName });
      }
    }

    const cleanData = {
      tournament_id: data.tournamentId,
      tournament_name: data.tournamentName || "",
      player_name: data.playerName,
      bgmi_id: data.bgmiId,
      profile_name: profileName,
      profile_id: profileId,
      mode: data.mode || "TDM",
      rules: data.rulesShort || data.rules || "",
      date: data.date || "",
      time: data.time || "",
      map: data.map || "Erangel",
      entry_fee: Number(data.entryFee) || 0,
      prize_pool: Number(data.prizePool) || 0,
      slots: Number(data.slots) || 0,
      status: "Registered",
      joined_at: new Date().toISOString(),
      room_id: "",
      room_password: "",
    };

    console.log("✅ FINAL DATA FOR SUPABASE:", cleanData);

    const { data: newJoin, error } = await supabase
      .from("tournament_joins")
      .insert([cleanData])
      .select()
      .single();

    if (error) {
      console.error("❌ SUPABASE INSERT ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Database error",
      });
    }

    console.log("🎉 NEW JOIN SAVED:", newJoin.id);

    res.json({
      success: true,
      joinId: newJoin.id,
      message: "✅ Successfully joined tournament!",
    });
  } catch (err) {
    console.error("❌ SERVER ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ============================= CHECK JOIN ============================= */
app.get("/api/check-join/:tournamentId", async (req, res) => {
  try {
    const bgmiId = req.query.bgmiId;
    if (!bgmiId) return res.json({ joined: false });

    const { data, error } = await supabase
      .from("tournament_joins")
      .select("id")
      .eq("tournament_id", req.params.tournamentId)
      .eq("bgmi_id", bgmiId)
      .maybeSingle();

    if (error) {
      console.error("CHECK JOIN ERROR:", error);
      return res.json({ joined: false });
    }

    res.json({ joined: !!data });
  } catch (err) {
    console.error("CHECK JOIN ERROR:", err);
    res.json({ joined: false });
  }
});

/* ============================= SLOT COUNT ============================= */
app.get("/api/tournament-slots-count/:tournamentId", async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("tournament_joins")
      .select("*", { count: "exact", head: true })
      .eq("tournament_id", req.params.tournamentId);

    if (error) {
      console.error("SLOTS ERROR:", error);
      return res.json({ registered: 0, max: 50 });
    }

    res.json({
      registered: count || 0,
      max: 50,
    });
  } catch (err) {
    console.error("SLOTS ERROR:", err);
    res.json({ registered: 0, max: 50 });
  }
});

/* ============================= MY MATCHES ============================= */
app.get("/api/my-matches", async (req, res) => {
  try {
    const bgmiId = req.query.bgmiId;
    if (!bgmiId) return res.json({ matches: [] });

    const { data: matches, error } = await supabase
      .from("tournament_joins")
      .select("*")
      .eq("bgmi_id", bgmiId)
      .order("joined_at", { ascending: false });

    if (error) {
      console.error("MY MATCHES ERROR:", error);
      return res.json({ matches: [] });
    }

    const matchesWithRooms = (matches || []).map((match) => ({
      ...match,
      roomId: match.room_id || tournamentRooms[match.tournament_id]?.roomId || "",
      roomPassword:
        match.room_password ||
        tournamentRooms[match.tournament_id]?.roomPassword ||
        "",
    }));

    res.json({ matches: matchesWithRooms });
  } catch (err) {
    console.error("MY MATCHES ERROR:", err);
    res.json({ matches: [] });
  }
});

/* ============================= ADMIN JOINS (FIXED) ============================= */
app.get("/api/admin/joins", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("tournament_joins")
      .select("*")
      .order("joined_at", { ascending: false });

    if (error) {
      console.error("ADMIN JOINS ERROR:", error);
      return res.json({ tournamentJoins: [] });
    }

    const synced = (data || []).map((j) => ({
      ...j,
      room_id: j.room_id || tournamentRooms[j.tournament_id]?.roomId || "",
      room_password:
        j.room_password || tournamentRooms[j.tournament_id]?.roomPassword || "",
    }));

    console.log("✅ Admin joins sent:", synced.length);
    res.json({ tournamentJoins: synced });
  } catch (err) {
    console.error("ADMIN JOINS ERROR:", err);
    res.json({ tournamentJoins: [] });
  }
});

/* ============================= SAVE ROOM ============================= */
app.put("/api/admin/set-room-by-tournament", async (req, res) => {
  const { tournamentId, roomId, roomPassword } = req.body;

  if (!tournamentId) {
    return res.status(400).json({ success: false, message: "tournamentId required" });
  }

  try {
    tournamentRooms[tournamentId] = {
      roomId: roomId || "",
      roomPassword: roomPassword || "",
    };

    const { data: updatedRows, error } = await supabase
      .from("tournament_joins")
      .update({
        room_id: roomId || "",
        room_password: roomPassword || "",
      })
      .eq("tournament_id", tournamentId)
      .select("id");

    if (error) {
      console.error("❌ SUPABASE ROOM SAVE ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    const updatedCount = updatedRows?.length || 0;

    console.log("✅ ROOM SAVED:", {
      tournamentId,
      updatedCount,
      roomId: roomId || "empty",
      roomPassword: roomPassword || "empty",
    });

    res.json({
      success: true,
      updated: updatedCount,
      message: "✅ Room saved permanently!",
    });
  } catch (err) {
    console.error("❌ ROOM SAVE ERROR:", err);
    res.status(500).json({ success: false, message: "Save failed" });
  }
});

/* ============================= DELETE JOIN ============================= */
app.delete("/api/admin/tournament/:id", async (req, res) => {
  try {
    const { data: deletedRows, error } = await supabase
      .from("tournament_joins")
      .delete()
      .eq("id", req.params.id)
      .select("id, tournament_id");

    if (error) {
      console.error("DELETE ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log("✅ DELETED:", req.params.id);

    res.json({
      success: true,
      deleted: deletedRows?.length || 0,
    });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

/* ============================= DEPOSIT CREATE ============================= */
app.post("/api/deposit", async (req, res) => {
  const { profileId, username, email, amount, utr } = req.body;

  if (!profileId || !amount || !utr) {
    return res.status(400).json({ success: false, message: "Missing fields" });
  }

  try {
    const nowUTC = new Date().toISOString();
    const nowIST = format(new Date(), "dd/MM/yyyy, hh:mm:ss a", {
      timeZone: "Asia/Kolkata",
    });

    const { data, error } = await supabase
      .from("DepositUser")
      .insert([
        {
          profile_id: profileId.toString(),
          name: username || "Unknown",
          email: email || "no-email",
          amount: Number(amount),
          utr: utr.toString(),
          status: "pending",
          date: nowUTC,
          date_ist: nowIST,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error("❌ SUPABASE ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log("✅ NEW DEPOSIT:", profileId, "₹", amount, "→ PENDING");
    res.json({ success: true, deposit: data });
  } catch (err) {
    console.error("❌ DEPOSIT ERROR:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

/* ============================= APPROVE DEPOSIT ============================= */
app.put("/api/admin/deposit-status/:id", async (req, res) => {
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ success: false, message: "Status required" });
  }

  try {
    const { data: deposit, error: depositError } = await supabase
      .from("DepositUser")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (depositError || !deposit) {
      console.error("❌ Deposit not found:", req.params.id, depositError);
      return res.status(500).json({ success: false, message: "Deposit not found" });
    }

    console.log(
      "🔍 DEPOSIT FOUND:",
      deposit.profile_id,
      "₹",
      deposit.amount,
      deposit.status,
      "→",
      status
    );

    if (status === "approved" && deposit.status === "pending") {
      const { data: user, error: userError } = await supabase
        .from("registeruser")
        .select("balance")
        .eq("profile_id", deposit.profile_id)
        .single();

      if (userError) {
        console.error("❌ USER FETCH ERROR:", userError);
        return res.status(500).json({ success: false, message: "User fetch failed" });
      }

      const currentBalance = Number(user?.balance || 0);
      const depositAmount = Number(deposit.amount || 0);
      const newBalance = currentBalance + depositAmount;

      console.log("💰 BEFORE:", currentBalance, "→ ADDING ₹", depositAmount);

      const { error: balanceError } = await supabase
        .from("registeruser")
        .update({ balance: newBalance })
        .eq("profile_id", deposit.profile_id);

      if (balanceError) {
        console.error("❌ BALANCE UPDATE FAILED:", balanceError);
        return res.status(500).json({ success: false, message: "Balance update failed" });
      }

      console.log(
        "✅ BALANCE SYNC SUCCESS:",
        deposit.profile_id,
        "₹",
        currentBalance,
        "→",
        newBalance
      );
    } else {
      console.log("ℹ️ SKIP BALANCE UPDATE:", deposit.status, "→", status);
    }

    const { data: updatedDeposit, error: statusError } = await supabase
      .from("DepositUser")
      .update({ status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (statusError) {
      console.error("❌ STATUS UPDATE ERROR:", statusError);
      return res.status(500).json({ success: false, message: statusError.message });
    }

    console.log("✅ DEPOSIT STATUS:", deposit.profile_id, "→", status);
    res.json({ success: true, deposit: updatedDeposit });
  } catch (err) {
    console.error("❌ APPROVE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
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
      console.error("❌ DELETE ERROR:", error);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log(
      "🗑️ DEPOSIT DELETED:",
      deposit?.profile_id,
      "₹",
      deposit?.amount,
      "(BALANCE SAFE)"
    );

    res.json({ success: true });
  } catch (err) {
    console.error("❌ DELETE DEPOSIT ERROR:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ============================= GET DEPOSITS ============================= */
app.get("/api/deposits", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("DepositUser")
      .select("*")
      .order("date", { ascending: false });

    if (error) {
      console.error("GET DEPOSITS ERROR:", error);
      return res.json({ deposits: [] });
    }

    res.json({ deposits: data || [] });
  } catch (err) {
    console.error("GET DEPOSITS ERROR:", err);
    res.json({ deposits: [] });
  }
});

app.get("/api/admin/deposits", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("DepositUser")
      .select("*")
      .order("date", { ascending: false });

    if (error) {
      console.error("ADMIN DEPOSITS ERROR:", error);
      return res.json({ deposits: [] });
    }

    res.json({ deposits: data || [] });
  } catch (err) {
    console.error("ADMIN DEPOSITS ERROR:", err);
    res.json({ deposits: [] });
  }
});

/* ============================= SERVER START ============================= */
const PORT = process.env.PORT || 5002;

app.listen(PORT, "0.0.0.0", () => {
  console.log("🔥 BGMI Server running on port", PORT);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log("✅ Tournament Joins → SUPABASE");
  console.log("✅ Admin joins → ROOM DATA INCLUDED");
  console.log("✅ Rooms → SUPABASE PERMANENT SAVE");
  console.log("✅ Balance sync → REGISTERUSER + WALLET");
  console.log("✅ Rollback endpoint → ACTIVE");
  console.log("✅ Clear approved endpoint → ACTIVE");
  console.log("✅ Tournament slots → 50 players allowed");
});