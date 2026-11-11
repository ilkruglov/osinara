-- A personal health journal (навык здоровья, 11 ноября 2026): food and drinks, body measurements,
-- sleep, daily activity, workouts and goals of one person, kept and read only in their private chat.
-- Every row belongs to `owner_user_id`; the family group and other members never see it.
--
-- Numbers the model estimates (food) are stored with how they were estimated; every sum, target and
-- expenditure is computed by application code from these rows, never written by the model.
-- `local_date` is the person's civil date at write time, so a day stays the same day after a later
-- timezone change. Sleep belongs to the day of waking.

-- Body parameters for the formulas and the person's own targets. A `deficit_block` (pregnancy,
-- lactation, an eating disorder, a doctor's word) forbids a weight-loss goal in code.
CREATE TABLE health_profiles (
  owner_user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  sex text CHECK (sex IN ('female', 'male')),
  birth_date date CHECK (birth_date >= DATE '1900-01-01'),
  height_cm numeric(4, 1) CHECK (height_cm BETWEEN 100 AND 250),
  activity_level text
    CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal text CHECK (goal IN ('lose', 'maintain', 'gain')),
  weekly_rate_kg numeric(3, 2) CHECK (weekly_rate_kg > 0 AND weekly_rate_kg <= 1),
  deficit_block text
    CHECK (deficit_block IN ('pregnancy', 'lactation', 'eating_disorder', 'medical')),
  manual_kcal integer CHECK (manual_kcal BETWEEN 800 AND 6000),
  manual_protein_g integer CHECK (manual_protein_g BETWEEN 0 AND 400),
  manual_fat_g integer CHECK (manual_fat_g BETWEEN 0 AND 400),
  manual_carbs_g integer CHECK (manual_carbs_g BETWEEN 0 AND 1000),
  manual_fiber_g integer CHECK (manual_fiber_g BETWEEN 0 AND 150),
  manual_water_ml integer CHECK (manual_water_ml BETWEEN 0 AND 8000),
  -- The weekly check's correction of the formula expenditure, accepted by the person.
  expenditure_adjustment_kcal integer NOT NULL DEFAULT 0
    CHECK (expenditure_adjustment_kcal BETWEEN -800 AND 800),
  adjustment_applied_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (goal IS DISTINCT FROM 'lose' OR deficit_block IS NULL)
);

-- One meal or drink. `items` holds the composition: name, amount with unit, values per 100 g/ml and
-- whether it counts as water; the total columns are computed from it by application code.
CREATE TABLE health_food_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at timestamptz NOT NULL,
  local_date date NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  estimate_source text NOT NULL
    CHECK (estimate_source IN ('label', 'weighed', 'described', 'photo')),
  items jsonb NOT NULL
    CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 30),
  kcal numeric(7, 1) NOT NULL CHECK (kcal BETWEEN 0 AND 20000),
  protein_g numeric(6, 1) NOT NULL CHECK (protein_g BETWEEN 0 AND 2000),
  fat_g numeric(6, 1) NOT NULL CHECK (fat_g BETWEEN 0 AND 2000),
  carbs_g numeric(6, 1) NOT NULL CHECK (carbs_g BETWEEN 0 AND 4000),
  fiber_g numeric(6, 1) NOT NULL CHECK (fiber_g BETWEEN 0 AND 1000),
  water_ml integer NOT NULL DEFAULT 0 CHECK (water_ml BETWEEN 0 AND 20000),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_food_entries_day
  ON health_food_entries (owner_user_id, local_date) WHERE removed_at IS NULL;

-- Weight and body composition. An imported row carries the export's own key, so a second import of
-- the same file adds nothing.
CREATE TABLE health_body_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  measured_at timestamptz NOT NULL,
  local_date date NOT NULL,
  weight_kg numeric(5, 2) CHECK (weight_kg BETWEEN 20 AND 400),
  body_fat_pct numeric(4, 1) CHECK (body_fat_pct BETWEEN 2 AND 75),
  muscle_pct numeric(4, 1) CHECK (muscle_pct BETWEEN 10 AND 90),
  waist_cm numeric(4, 1) CHECK (waist_cm BETWEEN 30 AND 250),
  source text NOT NULL CHECK (source IN ('text', 'screenshot', 'zepp')),
  external_key text CHECK (char_length(external_key) BETWEEN 1 AND 100),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (weight_kg IS NOT NULL OR body_fat_pct IS NOT NULL OR waist_cm IS NOT NULL),
  CHECK ((source = 'zepp') = (external_key IS NOT NULL))
);
CREATE UNIQUE INDEX health_body_measurements_import
  ON health_body_measurements (owner_user_id, source, external_key)
  WHERE external_key IS NOT NULL;
CREATE INDEX health_body_measurements_day
  ON health_body_measurements (owner_user_id, local_date) WHERE removed_at IS NULL;

-- The main sleep of a night, one per day of waking. A row typed in the chat is never replaced by an
-- import; an imported row is refreshed by the next import.
CREATE TABLE health_sleep (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wake_date date NOT NULL,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  sleep_start timestamptz,
  sleep_end timestamptz,
  total_min integer NOT NULL CHECK (total_min BETWEEN 1 AND 1440),
  deep_min integer CHECK (deep_min BETWEEN 0 AND 1440),
  light_min integer CHECK (light_min BETWEEN 0 AND 1440),
  rem_min integer CHECK (rem_min BETWEEN 0 AND 1440),
  awake_min integer CHECK (awake_min BETWEEN 0 AND 1440),
  source text NOT NULL CHECK (source IN ('text', 'screenshot', 'zepp')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, wake_date),
  CHECK (sleep_start IS NULL OR sleep_end IS NULL OR sleep_end > sleep_start)
);

-- Steps, distance and resting pulse of one day, with the same import rule as sleep.
CREATE TABLE health_activity_days (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  steps integer CHECK (steps BETWEEN 0 AND 150000),
  distance_m integer CHECK (distance_m BETWEEN 0 AND 300000),
  resting_hr integer CHECK (resting_hr BETWEEN 25 AND 200),
  source text NOT NULL CHECK (source IN ('text', 'screenshot', 'zepp')),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, local_date),
  CHECK (steps IS NOT NULL OR distance_m IS NOT NULL OR resting_hr IS NOT NULL)
);

-- A workout; a strength one keeps its sets, and the tonnage is computed from them.
CREATE TABLE health_workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  local_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('strength', 'cardio', 'sport', 'mobility')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 1 AND 720),
  intensity text NOT NULL CHECK (intensity IN ('light', 'moderate', 'vigorous')),
  -- Wide enough for anything the input allows: 300 sets × 1000 kg × 1000 reps.
  tonnage_kg numeric(12, 1) NOT NULL DEFAULT 0 CHECK (tonnage_kg >= 0),
  set_count integer NOT NULL DEFAULT 0 CHECK (set_count BETWEEN 0 AND 300),
  note text CHECK (char_length(note) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_workouts_day
  ON health_workouts (owner_user_id, local_date) WHERE removed_at IS NULL;

CREATE TABLE health_workout_sets (
  workout_id uuid NOT NULL REFERENCES health_workouts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 300),
  exercise text NOT NULL CHECK (char_length(exercise) BETWEEN 1 AND 100),
  -- The lower-cased name with ё as е and collapsed spaces: «Жим лёжа» and «жим  лежа» are one.
  exercise_key text NOT NULL CHECK (char_length(exercise_key) BETWEEN 1 AND 100),
  weight_kg numeric(6, 2) CHECK (weight_kg BETWEEN 0 AND 1000),
  reps integer CHECK (reps BETWEEN 1 AND 1000),
  duration_s integer CHECK (duration_s BETWEEN 1 AND 36000),
  PRIMARY KEY (workout_id, position),
  CHECK (reps IS NOT NULL OR duration_s IS NOT NULL)
);
CREATE INDEX health_workout_sets_exercise ON health_workout_sets (exercise_key, workout_id);

-- The Eve call id of each write: a replayed step returns the stored result and changes nothing.
CREATE TABLE health_operations (
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_key text NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 500),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, operation_key)
);
