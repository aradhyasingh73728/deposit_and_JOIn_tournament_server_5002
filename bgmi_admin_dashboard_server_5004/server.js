require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 5004;

// ============================================================
// CORS
// ============================================================
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

app.use(
  express.json({
    limit: "1mb",
  })
);

// ============================================================
// ENVIRONMENT
// ============================================================
const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  console.error(
    "❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env"
  );

  process.exit(1);
}

// ============================================================
// SUPABASE
// Service role key ONLY on backend
// ============================================================
const supabase =
  createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

// ============================================================
// CURRENT TOURNAMENT CATALOG
// ============================================================
const TOURNAMENT_CATALOG = [
  {
    id: "GYJHYTU",
    tournamentId: "GYJHYTU",
    name: "BGMI Livik",
    type: "Warriors",
    teamType: "Solo",
    mode: "Classic",
    map: "Livik",
    time: "12:00 PM",
    entryFee: 15,
    prizePool: 30,
    perKill: 8,
    maxSlots: 50,
    rulesShort: "Solo • Any Gun",
    gun: "Any",
  },

  {
    id: "KFHU41R",
    tournamentId: "KFHU41R",
    name: "BGMI Erangel",
    type: "Warriors",
    teamType: "Solo",
    mode: "Classic",
    map: "Erangel",
    time: "2:00 PM",
    entryFee: 20,
    prizePool: 30,
    perKill: 10,
    maxSlots: 50,
    rulesShort: "Solo • Sniper Only",
    gun: "Sniper",
  },

  {
    id: "LOIUJ77",
    tournamentId: "LOIUJ77",
    name: "BGMI Miramar",
    type: "Warriors",
    teamType: "Squad",
    mode: "Classic",
    map: "Miramar",
    time: "7:00 PM",
    entryFee: 15,
    prizePool: 30,
    perKill: 8,
    maxSlots: 50,
    rulesShort: "4-Man Squad • Team Play",
    gun: "Any",
  },

  {
    id: "CVGFDC5",
    tournamentId: "CVGFDC5",
    name: "BGMI Livik TDM",
    type: "Warriors",
    teamType: "4v4",
    mode: "TDM",
    map: "Livik",
    time: "8:00 PM",
    entryFee: 15,
    prizePool: 30,
    perKill: 8,
    maxSlots: 50,
    rulesShort: "4v4 • No Hacks",
    gun: "Any",
  },

  {
    id: "ASDFG65",
    tournamentId: "ASDFG65",
    name: "BGMI Erangel Duo",
    type: "Warriors",
    teamType: "Duo",
    mode: "Classic",
    map: "Erangel",
    time: "9:00 PM",
    entryFee: 15,
    prizePool: 30,
    perKill: 8,
    maxSlots: 50,
    rulesShort: "2-Man Duo • Team Play",
    gun: "Any",
  },
];

// ============================================================
// RUNTIME STATE
// ============================================================
const localVisibility =
  new Map();

const settlementLocks =
  new Set();

// ============================================================
// HELPERS
// ============================================================
function numberValue(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function integerValue(
  value,
  fallback = 0
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.floor(n);
}

function textValue(
  value,
  fallback = ""
) {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  return String(value);
}

function normalizeStatus(
  value
) {
  return textValue(
    value,
    "unknown"
  )
    .trim()
    .toLowerCase();
}

function safeDate(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function isToday(value) {
  if (!value) {
    return false;
  }

  const d =
    new Date(value);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return false;
  }

  const now =
    new Date();

  return (
    d.getFullYear() ===
      now.getFullYear() &&
    d.getMonth() ===
      now.getMonth() &&
    d.getDate() ===
      now.getDate()
  );
}

function isLiveStatus(
  status
) {
  return [
    "live",
    "ongoing",
    "running",
    "started",
    "active",
  ].includes(
    normalizeStatus(status)
  );
}

function isCompletedStatus(
  status
) {
  return [
    "completed",
    "complete",
    "finished",
    "closed",
  ].includes(
    normalizeStatus(status)
  );
}

function getCatalogTournament(
  id
) {
  return (
    TOURNAMENT_CATALOG.find(
      (tournament) =>
        String(tournament.id) ===
        String(id)
    ) || null
  );
}

function getTournamentPerKill(
  tournament
) {
  return Math.max(
    0,
    numberValue(
      tournament?.per_kill ??
        tournament?.perKill ??
        0
    )
  );
}

function getTournamentWinnerPrize(
  tournament
) {
  return Math.max(
    0,
    numberValue(
      tournament?.winner_prize ??
        tournament?.winnerPrize ??
        tournament?.prize_pool ??
        tournament?.prizePool ??
        0
    )
  );
}

function getTournamentMaxSlots(
  tournament
) {
  const value =
    numberValue(
      tournament?.max_slots ??
        tournament?.maxSlots ??
        tournament?.slots ??
        50
    );

  return value > 0
    ? Math.floor(value)
    : 50;
}

function normalizeTournamentRow(
  tournament,
  registered = 0
) {
  const maxSlots =
    getTournamentMaxSlots(
      tournament
    );

  const occupancy =
    maxSlots
      ? Number(
          Math.min(
            100,
            (registered /
              maxSlots) *
              100
          ).toFixed(1)
        )
      : 0;

  const memoryVisibility =
    localVisibility.get(
      String(tournament.id)
    );

  return {
    ...tournament,

    id: tournament.id,

    name:
      tournament.name ||
      tournament.tournament_name ||
      "Unnamed Tournament",

    mode:
      tournament.mode ||
      "—",

    map:
      tournament.map ||
      "—",

    entry_fee:
      numberValue(
        tournament.entry_fee ??
          tournament.entryFee ??
          0
      ),

    prize_pool:
      numberValue(
        tournament.prize_pool ??
          tournament.prizePool ??
          0
      ),

    per_kill:
      numberValue(
        tournament.per_kill ??
          tournament.perKill ??
          0
      ),

    max_slots:
      maxSlots,

    registered,

    occupancy,

    status:
      tournament.status ||
      (registered >= maxSlots
        ? "Full"
        : "Scheduled"),

    is_visible:
      memoryVisibility !==
      undefined
        ? memoryVisibility
        : tournament.is_visible !==
          false,
  };
}

// ============================================================
// IMPORTANT RESULT FILTER
//
// Same tournament ID ko multiple matches ke liye reuse kiya
// ja raha hai.
//
// Current match ki identity current tournament_joins ke
// join IDs se li jayegi.
//
// Old/deleted join ke results current match me nahi aayenge.
// ============================================================
function filterResultsToCurrentJoins(
  results,
  joins
) {
  const currentJoinIds =
    new Set(
      (joins || []).map(
        (join) =>
          String(join.id)
      )
    );

  return (results || []).filter(
    (result) =>
      currentJoinIds.has(
        String(result.join_id)
      )
  );
}

// ============================================================
// OPTIONAL TABLE CHECK
// ============================================================
async function tableExists(
  table
) {
  try {
    const {
      error,
    } = await supabase
      .from(table)
      .select("*")
      .limit(1);

    return !error;
  } catch {
    return false;
  }
}

// ============================================================
// OPTIONAL TOURNAMENT TABLE
// ============================================================
async function getOptionalTournamentsTable() {
  try {
    const {
      data,
      error,
    } = await supabase
      .from("tournaments")
      .select("*")
      .order("id", {
        ascending:
          false,
      });

    if (error) {
      return {
        exists: false,
        data: [],
        error,
      };
    }

    return {
      exists: true,
      data: data || [],
      error: null,
    };
  } catch (error) {
    return {
      exists: false,
      data: [],
      error,
    };
  }
}

// ============================================================
// ALL JOINS
// ============================================================
async function getAllJoins() {
  return supabase
    .from(
      "tournament_joins"
    )
    .select("*")
    .order("joined_at", {
      ascending:
        false,
    });
}

// ============================================================
// TOURNAMENT JOINS
// ============================================================
async function getJoinsByTournament(
  tournamentId
) {
  return supabase
    .from(
      "tournament_joins"
    )
    .select("*")
    .eq(
      "tournament_id",
      tournamentId
    )
    .order("joined_at", {
      ascending:
        true,
    });
}

// ============================================================
// GET TOURNAMENT
// ============================================================
async function getTournamentById(
  tournamentId
) {
  const tableResult =
    await getOptionalTournamentsTable();

  if (
    tableResult.exists
  ) {
    const found =
      (
        tableResult.data ||
        []
      ).find(
        (tournament) =>
          String(
            tournament.id
          ) ===
          String(
            tournamentId
          )
      );

    if (found) {
      return {
        data: found,
        source:
          "database",
      };
    }
  }

  const catalog =
    getCatalogTournament(
      tournamentId
    );

  if (catalog) {
    return {
      data: catalog,
      source:
        "catalog",
    };
  }

  const {
    data: joins,
    error,
  } =
    await getJoinsByTournament(
      tournamentId
    );

  if (
    !error &&
    joins &&
    joins.length
  ) {
    const first =
      joins[0];

    return {
      data: {
        id: tournamentId,

        name:
          first.tournament_name ||
          `Tournament ${tournamentId}`,

        mode:
          first.mode ||
          "—",

        map:
          first.map ||
          "—",

        entry_fee:
          numberValue(
            first.entry_fee
          ),

        prize_pool:
          numberValue(
            first.prize_pool
          ),

        slots:
          numberValue(
            first.slots
          ) || 50,

        status:
          "Scheduled",

        is_visible:
          true,
      },

      source:
        "joins",
    };
  }

  return {
    data: null,
    source: null,
  };
}

// ============================================================
// TOURNAMENT STATUS UPDATE
//
// NOTE:
// Same tournament ID reuse ho raha hai.
// Isliye settlement ke baad catalog/database tournament
// record ko permanently "completed" karna nahi chahiye.
//
// Function retained for compatibility, but settlement route
// isko call nahi karega.
// ============================================================
async function updateTournamentStatusBestEffort(
  tournamentId,
  status
) {
  const exists =
    await tableExists(
      "tournaments"
    );

  if (!exists) {
    return null;
  }

  try {
    const {
      data,
      error,
    } = await supabase
      .from("tournaments")
      .update({
        status,
      })
      .eq(
        "id",
        tournamentId
      )
      .select()
      .maybeSingle();

    if (error) {
      console.warn(
        "⚠️ Tournament status update skipped:",
        error.message
      );

      return null;
    }

    return data;
  } catch (error) {
    console.warn(
      "⚠️ Tournament status update failed:",
      error.message
    );

    return null;
  }
}

// ============================================================
// ROOT
// ============================================================
app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      server:
        "BGMI Admin Dashboard Server",
      port: PORT,
      message:
        "✅ 5004 admin server is running",
    });
  }
);

// ============================================================
// HEALTH
// ============================================================
app.get(
  "/health",
  async (req, res) => {
    try {
      const requiredTables = [
        "registeruser",
        "tournament_joins",
        "DepositUser",
        "withdraw_request",
        "user_bank_details",
      ];

      const tableStatus = {};

      await Promise.all(
        requiredTables.map(
          async (table) => {
            tableStatus[table] =
              await tableExists(
                table
              );
          }
        )
      );

      const ok =
        tableStatus.registeruser &&
        tableStatus.tournament_joins;

      res
        .status(
          ok ? 200 : 500
        )
        .json({
          success: ok,

          server:
            "5004",

          database:
            "service-role connected",

          tables:
            tableStatus,

          optional: {
            tournaments:
              await tableExists(
                "tournaments"
              ),

            tournament_results:
              await tableExists(
                "tournament_results"
              ),

            wallet_transactions:
              await tableExists(
                "wallet_transactions"
              ),
          },

          time:
            new Date().toISOString(),
        });
    } catch (error) {
      res.status(500).json({
        success: false,
        server:
          "5004",
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ADMIN USERS
// ============================================================
app.get(
  "/api/admin/users",
  async (req, res) => {
    try {
      const {
        data,
        error,
      } = await supabase
        .from(
          "registeruser"
        )
        .select("*")
        .order("id", {
          ascending:
            false,
        });

      if (error) {
        throw error;
      }

      res.json({
        users:
          data || [],
      });
    } catch (error) {
      res.status(500).json({
        users: [],
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ADMIN DEPOSITS
// ============================================================
app.get(
  "/api/admin/deposits",
  async (req, res) => {
    try {
      const {
        data,
        error,
      } = await supabase
        .from(
          "DepositUser"
        )
        .select("*")
        .order("date", {
          ascending:
            false,
        });

      if (error) {
        throw error;
      }

      res.json({
        deposits:
          data || [],
      });
    } catch (error) {
      res.status(500).json({
        deposits: [],
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ADMIN WITHDRAW REQUESTS
// ============================================================
app.get(
  "/api/admin/withdraw-requests",
  async (req, res) => {
    try {
      const {
        data,
        error,
      } = await supabase
        .from(
          "withdraw_request"
        )
        .select("*")
        .order(
          "created_at",
          {
            ascending:
              false,
          }
        );

      if (error) {
        throw error;
      }

      res.json({
        withdraws:
          data || [],
      });
    } catch (error) {
      res.status(500).json({
        withdraws: [],
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// ADMIN BANKS
// ============================================================
app.get(
  "/api/admin/all-banks",
  async (req, res) => {
    try {
      const {
        data,
        error,
      } = await supabase
        .from(
          "user_bank_details"
        )
        .select("*")
        .order(
          "created_at_ist",
          {
            ascending:
              false,
          }
        );

      if (error) {
        throw error;
      }

      res.json({
        banks:
          data || [],
      });
    } catch (error) {
      res.status(500).json({
        banks: [],
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// TOURNAMENT LIST
// ============================================================
app.get(
  "/api/admin/tournaments",
  async (req, res) => {
    try {
      const [
        tournamentTable,
        joinsResult,
      ] =
        await Promise.all([
          getOptionalTournamentsTable(),
          getAllJoins(),
        ]);

      if (
        joinsResult.error
      ) {
        throw joinsResult.error;
      }

      const joins =
        joinsResult.data ||
        [];

      const counts =
        new Map();

      joins.forEach(
        (join) => {
          const id =
            String(
              join.tournament_id ||
                ""
            );

          counts.set(
            id,
            (counts.get(id) ||
              0) + 1
          );
        }
      );

      const combined =
        new Map();

      if (
        tournamentTable.exists
      ) {
        (
          tournamentTable.data ||
          []
        ).forEach(
          (tournament) => {
            combined.set(
              String(
                tournament.id
              ),
              tournament
            );
          }
        );
      }

      TOURNAMENT_CATALOG.forEach(
        (tournament) => {
          if (
            !combined.has(
              String(
                tournament.id
              )
            )
          ) {
            combined.set(
              String(
                tournament.id
              ),
              tournament
            );
          }
        }
      );

      joins.forEach(
        (join) => {
          const id =
            String(
              join.tournament_id ||
                ""
            );

          if (
            !id ||
            combined.has(id)
          ) {
            return;
          }

          combined.set(
            id,
            {
              id,

              name:
                join.tournament_name ||
                `Tournament ${id}`,

              mode:
                join.mode ||
                "—",

              map:
                join.map ||
                "—",

              entry_fee:
                numberValue(
                  join.entry_fee
                ),

              prize_pool:
                numberValue(
                  join.prize_pool
                ),

              slots:
                numberValue(
                  join.slots
                ) || 50,

              status:
                "Scheduled",

              is_visible:
                true,
            }
          );
        }
      );

      const tournaments =
        Array.from(
          combined.values()
        ).map(
          (tournament) =>
            normalizeTournamentRow(
              tournament,
              counts.get(
                String(
                  tournament.id
                )
              ) || 0
            )
        );

      res.json({
        success: true,

        tournaments,

        source:
          tournamentTable.exists
            ? "database+catalog+joins"
            : "catalog+joins",
      });
    } catch (error) {
      console.error(
        "❌ GET TOURNAMENTS:",
        error.message
      );

      res.status(500).json({
        success: false,
        tournaments: [],
        error:
          error.message,
      });
    }
  }
);

// ============================================================
// LIVE DASHBOARD OVERVIEW
// ============================================================
app.get(
  "/api/admin/dashboard-overview",
  async (req, res) => {
    try {
      const [
        tournamentTable,
        usersResult,
        joinsResult,
        depositsResult,
        withdrawalsResult,
        banksResult,
        resultsAvailable,
        walletTxAvailable,
      ] =
        await Promise.all([
          getOptionalTournamentsTable(),

          supabase
            .from(
              "registeruser"
            )
            .select(
              "id,profile_id,username,email,balance,verified,register_time_ist"
            ),

          supabase
            .from(
              "tournament_joins"
            )
            .select(
              "id,tournament_id,tournament_name,player_name,bgmi_id,profile_id,profile_name,mode,date,time,map,entry_fee,prize_pool,slots,status,joined_at,room_id,room_password"
            )
            .order(
              "joined_at",
              {
                ascending:
                  false,
              }
            ),

          supabase
            .from(
              "DepositUser"
            )
            .select(
              "id,deposit_id,profile_id,name,amount,status,date,date_ist,utr"
            )
            .order(
              "date",
              {
                ascending:
                  false,
              }
            ),

          supabase
            .from(
              "withdraw_request"
            )
            .select(
              "id,withdraw_id,profile_id,profile_name,user_email,withdraw_amount,status,created_at,bank_info,updated_at"
            )
            .order(
              "created_at",
              {
                ascending:
                  false,
              }
            ),

          supabase
            .from(
              "user_bank_details"
            )
            .select(
              "id,user_id,profile_name,account_holder,bank_name,is_verified,is_active,created_at_ist"
            )
            .order(
              "created_at_ist",
              {
                ascending:
                  false,
              }
            ),

          tableExists(
            "tournament_results"
          ),

          tableExists(
            "wallet_transactions"
          ),
        ]);

      const users =
        usersResult.error
          ? []
          : usersResult.data ||
            [];

      const joins =
        joinsResult.error
          ? []
          : joinsResult.data ||
            [];

      const deposits =
        depositsResult.error
          ? []
          : depositsResult.data ||
            [];

      const withdrawals =
        withdrawalsResult.error
          ? []
          : withdrawalsResult.data ||
            [];

      const banks =
        banksResult.error
          ? []
          : banksResult.data ||
            [];

      let results = [];
      let walletTransactions =
        [];

      if (
        resultsAvailable
      ) {
        const {
          data,
          error,
        } = await supabase
          .from(
            "tournament_results"
          )
          .select(
            "id,tournament_id,join_id,bgmi_id,profile_id,player_name,kills,is_winner,per_kill,kill_amount,winner_prize,total_winning,status,created_at,paid_at"
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          );

        if (!error) {
          results =
            data || [];
        }
      }

      if (
        walletTxAvailable
      ) {
        const {
          data,
          error,
        } = await supabase
          .from(
            "wallet_transactions"
          )
          .select(
            "id,profile_id,type,amount,reference_type,reference_id,description,created_at"
          )
          .order(
            "created_at",
            {
              ascending:
                false,
            }
          );

        if (!error) {
          walletTransactions =
            data || [];
        }
      }

      const joinCountByTournament =
        new Map();

      joins.forEach(
        (join) => {
          const tournamentId =
            String(
              join.tournament_id ||
                ""
            );

          joinCountByTournament.set(
            tournamentId,
            (
              joinCountByTournament.get(
                tournamentId
              ) || 0
            ) + 1
          );
        }
      );

      const tournamentMap =
        new Map();

      if (
        tournamentTable.exists
      ) {
        (
          tournamentTable.data ||
          []
        ).forEach(
          (tournament) => {
            tournamentMap.set(
              String(
                tournament.id
              ),
              tournament
            );
          }
        );
      }

      TOURNAMENT_CATALOG.forEach(
        (tournament) => {
          if (
            !tournamentMap.has(
              String(
                tournament.id
              )
            )
          ) {
            tournamentMap.set(
              String(
                tournament.id
              ),
              tournament
            );
          }
        }
      );

      joins.forEach(
        (join) => {
          const tournamentId =
            String(
              join.tournament_id ||
                ""
            );

          if (
            !tournamentId ||
            tournamentMap.has(
              tournamentId
            )
          ) {
            return;
          }

          tournamentMap.set(
            tournamentId,
            {
              id:
                tournamentId,

              name:
                join.tournament_name ||
                `Tournament ${tournamentId}`,

              mode:
                join.mode ||
                "—",

              map:
                join.map ||
                "—",

              entry_fee:
                numberValue(
                  join.entry_fee
                ),

              prize_pool:
                numberValue(
                  join.prize_pool
                ),

              slots:
                numberValue(
                  join.slots
                ) || 50,

              status:
                "Scheduled",

              is_visible:
                true,
            }
          );
        }
      );

      const tournamentRows =
        Array.from(
          tournamentMap.values()
        ).map(
          (tournament) =>
            normalizeTournamentRow(
              tournament,
              joinCountByTournament.get(
                String(
                  tournament.id
                )
              ) || 0
            )
        );

      const totalWalletBalance =
        users.reduce(
          (sum, user) =>
            sum +
            numberValue(
              user.balance
            ),
          0
        );

      const pendingDeposits =
        deposits.filter(
          (deposit) =>
            normalizeStatus(
              deposit.status
            ) === "pending"
        );

      const approvedDeposits =
        deposits.filter(
          (deposit) =>
            [
              "approved",
              "success",
              "completed",
            ].includes(
              normalizeStatus(
                deposit.status
              )
            )
        );

      const rejectedDeposits =
        deposits.filter(
          (deposit) =>
            normalizeStatus(
              deposit.status
            ) === "rejected"
        );

      const pendingWithdrawals =
        withdrawals.filter(
          (withdraw) =>
            normalizeStatus(
              withdraw.status
            ) === "pending"
        );

      const approvedWithdrawals =
        withdrawals.filter(
          (withdraw) =>
            [
              "approved",
              "success",
              "completed",
            ].includes(
              normalizeStatus(
                withdraw.status
              )
            )
        );

      const rejectedWithdrawals =
        withdrawals.filter(
          (withdraw) =>
            normalizeStatus(
              withdraw.status
            ) === "rejected"
        );

      const verifiedBanks =
        banks.filter(
          (bank) =>
            bank.is_verified ===
              true &&
            bank.is_active !==
              false
        ).length;

      const recentActivity = [
        ...joins
          .slice(0, 30)
          .map(
            (join) => ({
              id:
                `join-${join.id}`,

              type:
                "join",

              title:
                join.player_name ||
                join.profile_name ||
                "Player",

              subtitle:
                `${
                  join.tournament_name ||
                  join.tournament_id ||
                  "Tournament"
                } • ${
                  join.bgmi_id ||
                  "No BGMI ID"
                }`,

              amount:
                numberValue(
                  join.entry_fee
                ),

              status:
                join.status ||
                "Registered",

              timestamp:
                safeDate(
                  join.joined_at
                ),
            })
          ),

        ...deposits
          .slice(0, 30)
          .map(
            (deposit) => ({
              id:
                `deposit-${deposit.id}`,

              type:
                "deposit",

              title:
                deposit.name ||
                deposit.profile_id ||
                "User",

              subtitle:
                `Deposit${
                  deposit.deposit_id
                    ? ` #${deposit.deposit_id}`
                    : ""
                }`,

              amount:
                numberValue(
                  deposit.amount
                ),

              status:
                deposit.status ||
                "pending",

              timestamp:
                safeDate(
                  deposit.date
                ),
            })
          ),

        ...withdrawals
          .slice(0, 30)
          .map(
            (withdraw) => ({
              id:
                `withdraw-${withdraw.id}`,

              type:
                "withdraw",

              title:
                withdraw.profile_name ||
                withdraw.profile_id ||
                "User",

              subtitle:
                `Withdraw #${
                  withdraw.withdraw_id ||
                  withdraw.id
                }`,

              amount:
                numberValue(
                  withdraw.withdraw_amount
                ),

              status:
                withdraw.status ||
                "pending",

              timestamp:
                safeDate(
                  withdraw.created_at
                ),
            })
          ),
      ]
        .filter(
          (item) =>
            item.timestamp
        )
        .sort(
          (a, b) =>
            new Date(
              b.timestamp
            ).getTime() -
            new Date(
              a.timestamp
            ).getTime()
        )
        .slice(0, 30);

      const modules = {
        database:
          true,

        users:
          !usersResult.error,

        tournaments:
          true,

        joins:
          !joinsResult.error,

        deposits:
          !depositsResult.error,

        withdrawals:
          !withdrawalsResult.error,

        banks:
          !banksResult.error,

        results:
          resultsAvailable,

        walletTransactions:
          walletTxAvailable,
      };

      res.json({
        success:
          true,

        generatedAt:
          new Date().toISOString(),

        modules,

        source: {
          tournamentMetadata:
            tournamentTable.exists
              ? "public.tournaments"
              : "tournamentsSample-compatible catalog",

          registrations:
            "public.tournament_joins",
        },

        stats: {
          users: {
            total:
              users.length,

            verified:
              users.filter(
                (user) =>
                  user.verified ===
                  true
              ).length,

            walletBalance:
              totalWalletBalance,
          },

          tournaments: {
            total:
              tournamentRows.length,

            visible:
              tournamentRows.filter(
                (tournament) =>
                  tournament.is_visible
              ).length,

            hidden:
              tournamentRows.filter(
                (tournament) =>
                  !tournament.is_visible
              ).length,

            live:
              tournamentRows.filter(
                (tournament) =>
                  isLiveStatus(
                    tournament.status
                  )
              ).length,

            completed:
              tournamentRows.filter(
                (tournament) =>
                  isCompletedStatus(
                    tournament.status
                  )
              ).length,
          },

          joins: {
            total:
              joins.length,

            today:
              joins.filter(
                (join) =>
                  isToday(
                    join.joined_at
                  )
              ).length,

            withRoom:
              joins.filter(
                (join) =>
                  textValue(
                    join.room_id
                  ).trim() !==
                  ""
              ).length,
          },

          deposits: {
            total:
              deposits.length,

            pending:
              pendingDeposits.length,

            approved:
              approvedDeposits.length,

            rejected:
              rejectedDeposits.length,

            pendingAmount:
              pendingDeposits.reduce(
                (
                  sum,
                  deposit
                ) =>
                  sum +
                  numberValue(
                    deposit.amount
                  ),
                0
              ),

            approvedAmount:
              approvedDeposits.reduce(
                (
                  sum,
                  deposit
                ) =>
                  sum +
                  numberValue(
                    deposit.amount
                  ),
                0
              ),
          },

          withdrawals: {
            total:
              withdrawals.length,

            pending:
              pendingWithdrawals.length,

            approved:
              approvedWithdrawals.length,

            rejected:
              rejectedWithdrawals.length,

            pendingAmount:
              pendingWithdrawals.reduce(
                (
                  sum,
                  withdraw
                ) =>
                  sum +
                  numberValue(
                    withdraw.withdraw_amount
                  ),
                0
              ),

            approvedAmount:
              approvedWithdrawals.reduce(
                (
                  sum,
                  withdraw
                ) =>
                  sum +
                  numberValue(
                    withdraw.withdraw_amount
                  ),
                0
              ),
          },

          banks: {
            total:
              banks.length,

            verified:
              verifiedBanks,

            active:
              banks.filter(
                (bank) =>
                  bank.is_active !==
                  false
              ).length,
          },

          results: {
            total:
              results.length,

            pending:
              results.filter(
                (result) =>
                  normalizeStatus(
                    result.status
                  ) === "pending"
              ).length,

            paid:
              results.filter(
                (result) =>
                  normalizeStatus(
                    result.status
                  ) === "paid"
              ).length,

            totalWinning:
              results.reduce(
                (
                  sum,
                  result
                ) =>
                  sum +
                  numberValue(
                    result.total_winning
                  ),
                0
              ),
          },
        },

        tournaments:
          tournamentRows,

        recentActivity,
      });
    } catch (error) {
      console.error(
        "❌ DASHBOARD OVERVIEW ERROR:",
        error.message
      );

      res.status(500).json({
        success:
          false,
        error:
          error.message ||
          "Dashboard overview failed",
      });
    }
  }
);

// ============================================================
// HIDE / UNHIDE
// ============================================================
async function setTournamentVisibility(
  id,
  visible,
  res
) {
  try {
    const hasTable =
      await tableExists(
        "tournaments"
      );

    if (hasTable) {
      const {
        data,
        error,
      } = await supabase
        .from(
          "tournaments"
        )
        .update({
          is_visible:
            visible,
        })
        .eq(
          "id",
          id
        )
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Tournament not found",
          });
      }

      return res.json({
        success:
          true,

        persistent:
          true,

        tournament:
          data,
      });
    }

    localVisibility.set(
      String(id),
      visible
    );

    return res.json({
      success:
        true,

      persistent:
        false,

      tournament: {
        id,

        is_visible:
          visible,
      },

      message:
        "Visibility updated for current 5004 session. Persistent visibility requires tournament metadata storage.",
    });
  } catch (error) {
    console.error(
      "❌ VISIBILITY UPDATE:",
      error.message
    );

    res.status(500).json({
      success:
        false,

      error:
        error.message,
    });
  }
}

app.put(
  "/api/admin/tournaments/:id/hide",
  (req, res) =>
    setTournamentVisibility(
      req.params.id,
      false,
      res
    )
);

app.put(
  "/api/admin/tournaments/:id/unhide",
  (req, res) =>
    setTournamentVisibility(
      req.params.id,
      true,
      res
    )
);

// ============================================================
// TOURNAMENT DETAIL
//
// IMPORTANT:
// Results are restricted to CURRENT join IDs.
// Old/deleted joins ke results current page ko nahi milenge.
// ============================================================
app.get(
  "/admin/tournament-joins/:id",
  async (req, res) => {
    try {
      const tournamentId =
        req.params.id;

      const [
        tournamentInfo,
        joinsResult,
        resultsAvailable,
      ] =
        await Promise.all([
          getTournamentById(
            tournamentId
          ),

          getJoinsByTournament(
            tournamentId
          ),

          tableExists(
            "tournament_results"
          ),
        ]);

      if (
        !tournamentInfo.data
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Tournament not found",

            users: [],
            results: [],
          });
      }

      if (
        joinsResult.error
      ) {
        throw joinsResult.error;
      }

      const currentJoins =
        joinsResult.data ||
        [];

      const tournament =
        normalizeTournamentRow(
          tournamentInfo.data,
          currentJoins.length
        );

      let results = [];

      if (
        resultsAvailable
      ) {
        const {
          data,
          error,
        } = await supabase
          .from(
            "tournament_results"
          )
          .select("*")
          .eq(
            "tournament_id",
            tournamentId
          )
          .order("id", {
            ascending:
              true,
          });

        if (error) {
          throw error;
        }

        results =
          filterResultsToCurrentJoins(
            data || [],
            currentJoins
          );
      }

      const resultsLocked =
        results.some(
          (result) => {
            const status =
              normalizeStatus(
                result.status
              );

            return (
              status ===
                "paid" ||
              status ===
                "settled"
            );
          }
        );

      res.json({
        success:
          true,

        tournament,

        users:
          currentJoins,

        results,

        resultsLocked,

        maxSlots:
          getTournamentMaxSlots(
            tournamentInfo.data
          ),

        perKill:
          getTournamentPerKill(
            tournamentInfo.data
          ),

        winnerPrize:
          getTournamentWinnerPrize(
            tournamentInfo.data
          ),

        resultSystemAvailable:
          resultsAvailable,
      });
    } catch (error) {
      console.error(
        "❌ TOURNAMENT DETAIL:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,

        users: [],

        results: [],
      });
    }
  }
);

// ============================================================
// APPROVE JOIN
// ============================================================
app.put(
  "/admin/tournament-joins/:id/approve",
  async (req, res) => {
    try {
      const tournamentId =
        req.params.id;

      const userId =
        req.body?.userId;

      if (!userId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "userId is required",
          });
      }

      const {
        data,
        error,
      } = await supabase
        .from(
          "tournament_joins"
        )
        .update({
          status:
            "approved",
        })
        .eq(
          "tournament_id",
          tournamentId
        )
        .eq(
          "id",
          userId
        )
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Tournament join not found",
          });
      }

      res.json({
        success:
          true,

        join:
          data,
      });
    } catch (error) {
      console.error(
        "❌ APPROVE JOIN:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// REJECT JOIN
// ============================================================
app.put(
  "/admin/tournament-joins/:id/reject",
  async (req, res) => {
    try {
      const tournamentId =
        req.params.id;

      const userId =
        req.body?.userId;

      if (!userId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "userId is required",
          });
      }

      const {
        data,
        error,
      } = await supabase
        .from(
          "tournament_joins"
        )
        .update({
          status:
            "rejected",
        })
        .eq(
          "tournament_id",
          tournamentId
        )
        .eq(
          "id",
          userId
        )
        .select()
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Tournament join not found",
          });
      }

      res.json({
        success:
          true,

        join:
          data,
      });
    } catch (error) {
      console.error(
        "❌ REJECT JOIN:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// DELETE JOIN
// ============================================================
app.delete(
  "/admin/tournament-joins/:id",
  async (req, res) => {
    try {
      const tournamentId =
        req.params.id;

      const userId =
        req.body?.userId;

      if (!userId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "userId is required",
          });
      }

      const resultsTable =
        await tableExists(
          "tournament_results"
        );

      if (
        resultsTable
      ) {
        const {
          data:
            paidResult,
          error:
            paidResultError,
        } = await supabase
          .from(
            "tournament_results"
          )
          .select(
            "id,status"
          )
          .eq(
            "tournament_id",
            tournamentId
          )
          .eq(
            "join_id",
            userId
          )
          .eq(
            "status",
            "paid"
          )
          .maybeSingle();

        if (
          paidResultError
        ) {
          console.warn(
            "⚠️ PAID RESULT CHECK:",
            paidResultError.message
          );
        }

        if (
          paidResult
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              error:
                "Paid result cannot be deleted. Reverse/refund settlement first.",
            });
        }

        const {
          error:
            resultDeleteError,
        } = await supabase
          .from(
            "tournament_results"
          )
          .delete()
          .eq(
            "tournament_id",
            tournamentId
          )
          .eq(
            "join_id",
            userId
          );

        if (
          resultDeleteError
        ) {
          throw resultDeleteError;
        }
      }

      const {
        data,
        error,
      } = await supabase
        .from(
          "tournament_joins"
        )
        .delete()
        .eq(
          "tournament_id",
          tournamentId
        )
        .eq(
          "id",
          userId
        )
        .select("id")
        .maybeSingle();

      if (error) {
        throw error;
      }

      res.json({
        success:
          true,

        deleted:
          Boolean(data),
      });
    } catch (error) {
      console.error(
        "❌ DELETE JOIN:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// OLD WINNER ENDPOINT
// ============================================================
app.post(
  "/admin/tournament-declare-winner/:id",
  async (req, res) => {
    try {
      const tournamentId =
        req.params.id;

      const winnerId =
        req.body?.winnerId;

      if (!winnerId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "winnerId is required",
          });
      }

      const {
        data: joins,
        error,
      } =
        await getJoinsByTournament(
          tournamentId
        );

      if (error) {
        throw error;
      }

      const winnerExists =
        (joins || []).some(
          (join) =>
            String(
              join.id
            ) ===
            String(
              winnerId
            )
        );

      if (
        !winnerExists
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Winner join not found",
          });
      }

      const {
        error:
          winnerError,
      } = await supabase
        .from(
          "tournament_joins"
        )
        .update({
          status:
            "winner",
        })
        .eq(
          "tournament_id",
          tournamentId
        )
        .eq(
          "id",
          winnerId
        );

      if (winnerError) {
        throw winnerError;
      }

      const loserIds =
        (joins || [])
          .map(
            (join) =>
              join.id
          )
          .filter(
            (joinId) =>
              String(
                joinId
              ) !==
              String(
                winnerId
              )
          );

      if (
        loserIds.length
      ) {
        const {
          error:
            loserError,
        } = await supabase
          .from(
            "tournament_joins"
          )
          .update({
            status:
              "loser",
          })
          .eq(
            "tournament_id",
            tournamentId
          )
          .in(
            "id",
            loserIds
          );

        if (loserError) {
          throw loserError;
        }
      }

      res.json({
        success:
          true,

        winnerId,

        message:
          "✅ Winner status saved. Use result settlement for wallet credit.",
      });
    } catch (error) {
      console.error(
        "❌ DECLARE WINNER:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// SAVE TOURNAMENT RESULTS
//
// IMPORTANT FIX:
//
// Old paid result:
// GYJHYTU + old join_id
//
// Current match:
// GYJHYTU + current join_id
//
// Sirf current active join IDs ko paid lock maana jayega.
// ============================================================
app.post(
  "/admin/tournament-results/:id/save",
  async (req, res) => {
    try {
      const tournamentId =
        String(
          req.params.id ||
            ""
        ).trim();

      const submittedResults =
        Array.isArray(
          req.body?.results
        )
          ? req.body.results
          : [];

      if (!tournamentId) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Tournament ID required",
          });
      }

      if (
        !submittedResults.length
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Results are required",
          });
      }

      if (
        !(
          await tableExists(
            "tournament_results"
          )
        )
      ) {
        return res
          .status(503)
          .json({
            success:
              false,

            error:
              "tournament_results table is not available. Run the result-system SQL first.",
          });
      }

      const [
        tournamentInfo,
        joinsResult,
        existingResultQuery,
      ] =
        await Promise.all([
          getTournamentById(
            tournamentId
          ),

          getJoinsByTournament(
            tournamentId
          ),

          supabase
            .from(
              "tournament_results"
            )
            .select(
              "id,join_id,status"
            )
            .eq(
              "tournament_id",
              tournamentId
            ),
        ]);

      if (
        !tournamentInfo.data
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            error:
              "Tournament not found",
          });
      }

      if (
        joinsResult.error
      ) {
        throw joinsResult.error;
      }

      if (
        existingResultQuery.error
      ) {
        throw existingResultQuery.error;
      }

      // ======================================================
      // CURRENT ACTIVE JOINS
      // ======================================================
      const activeJoins =
        (
          joinsResult.data ||
          []
        ).filter(
          (join) =>
            normalizeStatus(
              join.status
            ) !== "rejected"
        );

      if (
        !activeJoins.length
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "No active tournament players found.",
          });
      }

      // ======================================================
      // CURRENT ACTIVE JOIN IDS
      // ======================================================
      const activeIds =
        new Set(
          activeJoins.map(
            (join) =>
              String(
                join.id
              )
          )
        );

      // ======================================================
      // EXISTING RESULTS
      // ======================================================
      const existingResults =
        existingResultQuery.data ||
        [];

      // ======================================================
      // CURRENT MATCH PAID RESULTS ONLY
      //
      // Old/deleted join ke paid result ko IGNORE karo.
      // ======================================================
      const currentPaidResults =
        existingResults.filter(
          (result) =>
            activeIds.has(
              String(
                result.join_id
              )
            ) &&
            [
              "paid",
              "settled",
            ].includes(
              normalizeStatus(
                result.status
              )
            )
        );

      if (
        currentPaidResults.length
      ) {
        const paidJoinIds =
          currentPaidResults.map(
            (result) =>
              String(
                result.join_id
              )
          );

        return res
          .status(400)
          .json({
            success:
              false,

            error:
              `Current player result already settled. Paid result cannot be edited. Join IDs: ${paidJoinIds.join(
                ", "
              )}`,
          });
      }

      // ======================================================
      // VALIDATE SUBMITTED JOIN IDs
      // ======================================================
      for (
        const item of
          submittedResults
      ) {
        if (
          !activeIds.has(
            String(
              item.joinId
            )
          )
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              error:
                `Invalid joinId: ${item.joinId}`,
            });
        }
      }

      // ======================================================
      // DUPLICATE SUBMITTED JOIN IDS
      // ======================================================
      const submittedIds =
        new Set(
          submittedResults.map(
            (item) =>
              String(
                item.joinId
              )
          )
        );

      if (
        submittedIds.size !==
        submittedResults.length
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Duplicate player result submitted.",
          });
      }

      // ======================================================
      // EVERY ACTIVE PLAYER REQUIRED
      // ======================================================
      if (
        submittedIds.size !==
        activeIds.size
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Har active player ka result submit hona chahiye.",
          });
      }

      // ======================================================
      // TOURNAMENT CONFIG
      // ======================================================
      const perKill =
        getTournamentPerKill(
          tournamentInfo.data
        );

      const winnerPrize =
        getTournamentWinnerPrize(
          tournamentInfo.data
        );

      // ======================================================
      // WINNER VALIDATION
      // ======================================================
      const winnerCount =
        submittedResults.filter(
          (item) =>
            Boolean(
              item.isWinner
            )
        ).length;

      if (
        winnerPrize > 0 &&
        winnerCount !== 1
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Exactly one winner is required.",
          });
      }

      // ======================================================
      // BUILD RESULT ROWS
      // ======================================================
      const rows =
        submittedResults.map(
          (item) => {
            const join =
              activeJoins.find(
                (row) =>
                  String(
                    row.id
                  ) ===
                  String(
                    item.joinId
                  )
              );

            if (!join) {
              throw new Error(
                `Join not found: ${item.joinId}`
              );
            }

            const profileId =
              textValue(
                join.profile_id
              ).trim();

            if (!profileId) {
              throw new Error(
                `Profile ID missing for join ${join.id}`
              );
            }

            const kills =
              Math.max(
                0,
                integerValue(
                  item.kills,
                  0
                )
              );

            const isWinner =
              Boolean(
                item.isWinner
              );

            const killAmount =
              kills *
              perKill;

            const winnerAmount =
              isWinner
                ? winnerPrize
                : 0;

            const totalWinning =
              killAmount +
              winnerAmount;

            return {
              tournament_id:
                tournamentId,

              join_id:
                join.id,

              bgmi_id:
                textValue(
                  join.bgmi_id
                ),

              profile_id:
                profileId,

              player_name:
                textValue(
                  join.player_name ||
                    join.profile_name
                ),

              kills,

              is_winner:
                isWinner,

              per_kill:
                perKill,

              kill_amount:
                killAmount,

              winner_prize:
                winnerAmount,

              total_winning:
                totalWinning,

              status:
                "pending",

              created_at:
                new Date().toISOString(),

              paid_at:
                null,
            };
          }
        );

      // ======================================================
      // UPSERT
      //
      // tournament_id + join_id
      // current player ka result uniquely maintain karega.
      // ======================================================
      const {
        data:
          savedResults,
        error:
          saveError,
      } = await supabase
        .from(
          "tournament_results"
        )
        .upsert(
          rows,
          {
            onConflict:
              "tournament_id,join_id",
          }
        )
        .select();

      if (saveError) {
        throw saveError;
      }

      const totalWinning =
        rows.reduce(
          (
            sum,
            row
          ) =>
            sum +
            numberValue(
              row.total_winning
            ),
          0
        );

      console.log(
        "✅ RESULTS SAVED:",
        {
          tournamentId,
          players:
            rows.length,
          totalWinning,
          currentJoinIds:
            rows.map(
              (row) =>
                row.join_id
            ),
        }
      );

      res.json({
        success:
          true,

        results:
          savedResults ||
          [],

        totalWinning,

        perKill,

        winnerPrize,

        message:
          "✅ Results calculated and saved successfully.",
      });
    } catch (error) {
      console.error(
        "❌ SAVE RESULTS:",
        error.message
      );

      res.status(500).json({
        success:
          false,

        error:
          error.message ||
          "Result save failed",
      });
    }
  }
);

// ============================================================
// SETTLE RESULTS / CREDIT WALLET
//
// IMPORTANT FIX:
//
// Settlement sirf CURRENT tournament joins ke pending
// results ko process karega.
//
// Purane/deleted joins ke pending results ignore honge.
// ============================================================
app.post(
  "/admin/tournament-results/:id/settle",
  async (req, res) => {
    const tournamentId =
      String(
        req.params.id ||
          ""
      ).trim();

    const lockKey =
      tournamentId;

    if (!tournamentId) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "Tournament ID required",
        });
    }

    // ========================================================
    // SERVER MEMORY LOCK
    // ========================================================
    if (
      settlementLocks.has(
        lockKey
      )
    ) {
      return res
        .status(409)
        .json({
          success:
            false,

          error:
            "Settlement already in progress for this tournament.",
        });
    }

    settlementLocks.add(
      lockKey
    );

    try {
      // ======================================================
      // TABLE CHECK
      // ======================================================
      const resultsTableExists =
        await tableExists(
          "tournament_results"
        );

      if (
        !resultsTableExists
      ) {
        return res
          .status(503)
          .json({
            success:
              false,

            error:
              "tournament_results table is not available.",
          });
      }

      const walletTableExists =
        await tableExists(
          "wallet_transactions"
        );

      if (
        !walletTableExists
      ) {
        return res
          .status(503)
          .json({
            success:
              false,

            error:
              "wallet_transactions table is required for safe winning settlement.",
          });
      }

      // ======================================================
      // CURRENT JOINS
      // ======================================================
      const {
        data:
          currentJoins,
        error:
          currentJoinsError,
      } =
        await getJoinsByTournament(
          tournamentId
        );

      if (
        currentJoinsError
      ) {
        throw currentJoinsError;
      }

      // ======================================================
      // CURRENT ACTIVE JOIN IDS
      // ======================================================
      const currentJoinIds =
        new Set(
          (
            currentJoins ||
            []
          )
            .filter(
              (join) =>
                normalizeStatus(
                  join.status
                ) !== "rejected"
            )
            .map(
              (join) =>
                String(
                  join.id
                )
            )
        );

      if (
        currentJoinIds.size ===
        0
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "No active current tournament players found.",
          });
      }

      // ======================================================
      // LOAD CURRENT PENDING RESULTS ONLY
      // ======================================================
      const {
        data:
          allPendingResults,
        error:
          pendingError,
      } = await supabase
        .from(
          "tournament_results"
        )
        .select("*")
        .eq(
          "tournament_id",
          tournamentId
        )
        .eq(
          "status",
          "pending"
        )
        .order("id", {
          ascending:
            true,
        });

      if (
        pendingError
      ) {
        throw pendingError;
      }

      const pendingResults =
        filterResultsToCurrentJoins(
          allPendingResults ||
            [],
          (
            currentJoins ||
            []
          ).filter(
            (join) =>
              normalizeStatus(
                join.status
              ) !== "rejected"
          )
        );

      if (
        pendingResults.length ===
        0
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "No pending results found for the current tournament match. Pehle Save / Calculate karo.",
          });
      }

      // ======================================================
      // PROFILE VALIDATION
      // ======================================================
      const invalidProfile =
        pendingResults.find(
          (result) =>
            !String(
              result.profile_id ||
                ""
            ).trim()
        );

      if (
        invalidProfile
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Ek ya more result records me profile_id missing hai.",
          });
      }

      // ======================================================
      // RESULT ID DUPLICATE CHECK
      // ======================================================
      const resultIds =
        new Set();

      for (
        const result of
          pendingResults
      ) {
        const resultId =
          String(
            result.id
          );

        if (
          resultIds.has(
            resultId
          )
        ) {
          return res
            .status(400)
            .json({
              success:
                false,

              error:
                "Duplicate result record detected.",
            });
        }

        resultIds.add(
          resultId
        );
      }

      // ======================================================
      // WINNER VALIDATION
      //
      // Pending current results only.
      // ======================================================
      const winnerCount =
        pendingResults.filter(
          (result) =>
            Boolean(
              result.is_winner
            )
        ).length;

      const totalPrize =
        pendingResults.reduce(
          (
            sum,
            result
          ) =>
            sum +
            numberValue(
              result.winner_prize
            ),
          0
        );

      if (
        totalPrize > 0 &&
        winnerCount !== 1
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Exactly one winner is required before settlement.",
          });
      }

      // ======================================================
      // PLAYER-BY-PLAYER SETTLEMENT
      // ======================================================
      let paidCount = 0;
      let totalPaid = 0;

      for (
        const result of
          pendingResults
      ) {
        const resultId =
          String(
            result.id
          );

        const profileId =
          String(
            result.profile_id
          ).trim();

        const amount =
          Math.max(
            0,
            numberValue(
              result.total_winning
            )
          );

        // ====================================================
        // VERIFY JOIN IS CURRENT
        // ====================================================
        if (
          !currentJoinIds.has(
            String(
              result.join_id
            )
          )
        ) {
          console.warn(
            "⚠️ SKIPPING OLD JOIN RESULT:",
            {
              tournamentId,
              resultId,
              joinId:
                result.join_id,
            }
          );

          continue;
        }

        // ====================================================
        // EXISTING TRANSACTION CHECK
        // ====================================================
        const {
          data:
            existingTransaction,
          error:
            transactionCheckError,
        } = await supabase
          .from(
            "wallet_transactions"
          )
          .select(
            "id,amount,profile_id,reference_type,reference_id"
          )
          .eq(
            "reference_type",
            "tournament_result"
          )
          .eq(
            "reference_id",
            resultId
          )
          .maybeSingle();

        if (
          transactionCheckError
        ) {
          throw transactionCheckError;
        }

        // ====================================================
        // TRANSACTION ALREADY EXISTS
        // ====================================================
        if (
          existingTransaction
        ) {
          const existingProfileId =
            String(
              existingTransaction.profile_id ||
                ""
            ).trim();

          const existingAmount =
            numberValue(
              existingTransaction.amount
            );

          if (
            existingProfileId !==
            profileId
          ) {
            throw new Error(
              `Transaction profile mismatch for result ${resultId}`
            );
          }

          if (
            existingAmount !==
            amount
          ) {
            throw new Error(
              `Transaction amount mismatch for result ${resultId}`
            );
          }

          const {
            data:
              markPaidData,
            error:
              markPaidError,
          } = await supabase
            .from(
              "tournament_results"
            )
            .update({
              status:
                "paid",

              paid_at:
                new Date().toISOString(),
            })
            .eq(
              "id",
              result.id
            )
            .eq(
              "status",
              "pending"
            )
            .select(
              "id,status"
            )
            .maybeSingle();

          if (
            markPaidError
          ) {
            throw markPaidError;
          }

          if (
            markPaidData
          ) {
            paidCount +=
              1;

            totalPaid +=
              existingAmount;
          }

          console.log(
            "ℹ️ EXISTING WINNING TRANSACTION:",
            {
              tournamentId,
              resultId,
              profileId,
              amount:
                existingAmount,
            }
          );

          continue;
        }

        // ====================================================
        // ZERO WINNING
        // ====================================================
        if (
          amount === 0
        ) {
          const {
            data:
              zeroPaid,
            error:
              zeroError,
          } = await supabase
            .from(
              "tournament_results"
            )
            .update({
              status:
                "paid",

              paid_at:
                new Date().toISOString(),
            })
            .eq(
              "id",
              result.id
            )
            .eq(
              "status",
              "pending"
            )
            .select(
              "id,status"
            )
            .maybeSingle();

          if (
            zeroError
          ) {
            throw zeroError;
          }

          if (
            zeroPaid
          ) {
            paidCount +=
              1;
          }

          continue;
        }

        // ====================================================
        // GET EXACT USER WALLET
        // ====================================================
        const {
          data:
            user,
          error:
            userError,
        } = await supabase
          .from(
            "registeruser"
          )
          .select(
            "profile_id,balance"
          )
          .eq(
            "profile_id",
            profileId
          )
          .maybeSingle();

        if (
          userError
        ) {
          throw userError;
        }

        if (!user) {
          throw new Error(
            `User not found for profile_id ${profileId}`
          );
        }

        // ====================================================
        // BALANCE
        // ====================================================
        const oldBalance =
          numberValue(
            user.balance
          );

        const newBalance =
          oldBalance +
          amount;

        // ====================================================
        // GUARDED WALLET UPDATE
        // ====================================================
        const {
          data:
            updatedUser,
          error:
            balanceError,
        } = await supabase
          .from(
            "registeruser"
          )
          .update({
            balance:
              newBalance,
          })
          .eq(
            "profile_id",
            profileId
          )
          .eq(
            "balance",
            user.balance
          )
          .select(
            "profile_id,balance"
          )
          .maybeSingle();

        if (
          balanceError
        ) {
          throw new Error(
            `Wallet update failed for ${profileId}: ${balanceError.message}`
          );
        }

        if (
          !updatedUser
        ) {
          throw new Error(
            `Wallet changed during settlement for ${profileId}. Settlement stopped safely.`
          );
        }

        // ====================================================
        // WALLET TRANSACTION
        // ====================================================
        const {
          data:
            walletTransaction,
          error:
            transactionInsertError,
        } = await supabase
          .from(
            "wallet_transactions"
          )
          .insert({
            profile_id:
              profileId,

            type:
              "winning",

            amount:
              amount,

            reference_type:
              "tournament_result",

            reference_id:
              resultId,

            description:
              `Tournament winning - ${
                result.player_name ||
                profileId
              }`,

            created_at:
              new Date().toISOString(),
          })
          .select()
          .single();

        // ====================================================
        // TRANSACTION INSERT FAILURE
        // ====================================================
        if (
          transactionInsertError
        ) {
          console.error(
            "❌ TRANSACTION INSERT FAILED:",
            transactionInsertError
          );

          // --------------------------------------------------
          // Duplicate transaction
          // --------------------------------------------------
          if (
            transactionInsertError.code ===
            "23505"
          ) {
            console.warn(
              "⚠️ Duplicate transaction detected. Verifying existing transaction..."
            );

            const {
              data:
                duplicateTransaction,
              error:
                duplicateCheckError,
            } = await supabase
              .from(
                "wallet_transactions"
              )
              .select(
                "id,amount,profile_id"
              )
              .eq(
                "reference_type",
                "tournament_result"
              )
              .eq(
                "reference_id",
                resultId
              )
              .maybeSingle();

            if (
              duplicateCheckError ||
              !duplicateTransaction
            ) {
              throw new Error(
                `Duplicate transaction detected but existing transaction could not be verified for result ${resultId}`
              );
            }

            const duplicateProfileId =
              String(
                duplicateTransaction.profile_id ||
                  ""
              ).trim();

            const duplicateAmount =
              numberValue(
                duplicateTransaction.amount
              );

            if (
              duplicateProfileId !==
                profileId ||
              duplicateAmount !==
                amount
            ) {
              throw new Error(
                `Duplicate transaction verification failed for result ${resultId}`
              );
            }

            /*
              NOTE:
              Same-process settlement lock already prevents
              duplicate settlement requests on this server.

              Existing transaction verify hone ke baad result
              paid mark karna safe hai.
            */

            const {
              data:
                duplicatePaidResult,
              error:
                duplicateMarkError,
            } = await supabase
              .from(
                "tournament_results"
              )
              .update({
                status:
                  "paid",

                paid_at:
                  new Date().toISOString(),
              })
              .eq(
                "id",
                result.id
              )
              .eq(
                "status",
                "pending"
              )
              .select(
                "id,status"
              )
              .maybeSingle();

            if (
              duplicateMarkError
            ) {
              throw duplicateMarkError;
            }

            if (
              duplicatePaidResult
            ) {
              paidCount +=
                1;

              totalPaid +=
                amount;
            }

            continue;
          }

          // --------------------------------------------------
          // Normal failure -> rollback balance
          // --------------------------------------------------
          const {
            data:
              rollbackUser,
            error:
              rollbackError,
          } = await supabase
            .from(
              "registeruser"
            )
            .update({
              balance:
                oldBalance,
            })
            .eq(
              "profile_id",
              profileId
            )
            .eq(
              "balance",
              newBalance
            )
            .select(
              "profile_id,balance"
            )
            .maybeSingle();

          if (
            rollbackError ||
            !rollbackUser
          ) {
            throw new Error(
              `CRITICAL: Transaction insert failed and wallet rollback failed for ${profileId}`
            );
          }

          throw new Error(
            `Winning transaction creation failed for ${profileId}. Wallet restored.`
          );
        }

        // ====================================================
        // MARK RESULT AS PAID
        // ====================================================
        const {
          data:
            paidResult,
          error:
            resultUpdateError,
        } = await supabase
          .from(
            "tournament_results"
          )
          .update({
            status:
              "paid",

            paid_at:
              new Date().toISOString(),
          })
          .eq(
            "id",
            result.id
          )
          .eq(
            "status",
            "pending"
          )
          .select(
            "id,status"
          )
          .maybeSingle();

        if (
          resultUpdateError
        ) {
          throw new Error(
            `Wallet credited for ${profileId}, but result status update failed for result ${resultId}.`
          );
        }

        if (
          !paidResult
        ) {
          throw new Error(
            `Result ${resultId} was already changed during settlement.`
          );
        }

        paidCount +=
          1;

        totalPaid +=
          amount;

        console.log(
          "✅ PLAYER WINNING CREDITED:",
          {
            tournamentId,

            resultId,

            joinId:
              result.join_id,

            profileId,

            amount,

            oldBalance,

            newBalance,

            walletTransactionId:
              walletTransaction?.id ||
              null,
          }
        );
      }

      // ======================================================
      // IMPORTANT:
      //
      // Tournament status ko "completed" database me set nahi
      // kar rahe because GYJHYTU same reusable tournament ID
      // hai. Future match ko Scheduled rehna chahiye.
      // ======================================================

      console.log(
        "✅ TOURNAMENT SETTLEMENT COMPLETE:",
        {
          tournamentId,
          paidCount,
          totalPaid,
        }
      );

      return res.json({
        success:
          true,

        paidCount,

        totalPaid,

        settlementMode:
          "backend-current-join-guarded",

        message:
          "✅ Winning credited for current tournament players successfully.",
      });
    } catch (error) {
      console.error(
        "❌ SETTLEMENT ERROR:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "Settlement failed",
        });
    } finally {
      settlementLocks.delete(
        lockKey
      );
    }
  }
);

// ============================================================
// DEBUG
// ============================================================
app.get(
  "/api/admin/debug",
  async (req, res) => {
    const tables = {};

    const tableNames = [
      "registeruser",
      "tournament_joins",
      "DepositUser",
      "withdraw_request",
      "user_bank_details",
      "tournaments",
      "tournament_results",
      "wallet_transactions",
    ];

    await Promise.all(
      tableNames.map(
        async (table) => {
          tables[table] =
            (await tableExists(
              table
            ))
              ? "OK"
              : "NOT AVAILABLE";
        }
      )
    );

    let settlementRpc =
      "NOT USED";

    res.json({
      success:
        true,

      server:
        "5004",

      port:
        PORT,

      tables,

      settlementRpc,

      settlementMode:
        "backend-current-join-guarded",

      resultIsolation:
        "CURRENT tournament_joins join_id based",

      catalogTournamentCount:
        TOURNAMENT_CATALOG.length,
    });
  }
);

// ============================================================
// JSON 404
// ============================================================
app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        success:
          false,

        error:
          `Route not found: ${req.method} ${req.originalUrl}`,
      });
  }
);

// ============================================================
// ERROR HANDLER
// ============================================================
app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "❌ UNHANDLED 5004 ERROR:",
      error
    );

    res
      .status(500)
      .json({
        success:
          false,

        error:
          error?.message ||
          "Internal server error",
      });
  }
);

// ============================================================
// START
// ============================================================
app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "===================================================="
    );

    console.log(
      `🚀 BGMI ADMIN SERVER 5004 LIVE ON PORT ${PORT}`
    );

    console.log(
      "✅ Dashboard → /api/admin/dashboard-overview"
    );

    console.log(
      "✅ Tournaments → /api/admin/tournaments"
    );

    console.log(
      "✅ Tournament detail → /admin/tournament-joins/:id"
    );

    console.log(
      "✅ Approve / Reject / Delete → ACTIVE"
    );

    console.log(
      "✅ Result Save → CURRENT JOIN IDs ONLY"
    );

    console.log(
      "✅ Winning Settlement → CURRENT JOIN IDs ONLY"
    );

    console.log(
      "✅ Old paid results cannot lock new current match"
    );

    console.log(
      "✅ Same tournament ID reuse supported"
    );

    console.log(
      "✅ Express 5 CORS → SAFE"
    );

    console.log(
      "===================================================="
    );
  }
);