-- PianoForte — MySQL schema
-- Изврши: mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS pianoforte CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pianoforte;

-- ============ USERS ============
CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt hash, НИКОГАШ чист текст
  role ENUM('admin','professor','student') NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============ GROUPS (4–6 деца по група) ============
CREATE TABLE IF NOT EXISTS groups_table (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  capacity INT NOT NULL DEFAULT 6,
  professor_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (professor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS group_members (
  group_id INT NOT NULL,
  student_id INT NOT NULL,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, student_id),
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============ SCHEDULE (еден термин неделно по група) ============
CREATE TABLE IF NOT EXISTS schedule_slots (
  id INT PRIMARY KEY AUTO_INCREMENT,
  group_id INT NOT NULL,
  day_of_week ENUM('mon','tue','wed','thu','fri','sat') NOT NULL,
  start_hour TINYINT NOT NULL,                  -- 9–18
  note TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (group_id) REFERENCES groups_table(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_slot (day_of_week, start_hour)
) ENGINE=InnoDB;

-- ============ DIGITAL INDEX / MATERIALS ============
CREATE TABLE IF NOT EXISTS materials (
  id INT PRIMARY KEY AUTO_INCREMENT,
  student_id INT NOT NULL,
  sent_by INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  type ENUM('note','audio','task') NOT NULL,
  note TEXT,
  status ENUM('queued','delivered','opened','done') DEFAULT 'queued',
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============ PACKAGES & PURCHASES ============
CREATE TABLE IF NOT EXISTS packages (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  price_mkd DECIMAL(10,2) NOT NULL,
  lessons_per_month INT NOT NULL,
  description VARCHAR(500)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchases (
  id INT PRIMARY KEY AUTO_INCREMENT,
  student_id INT NOT NULL,
  package_id INT NOT NULL,
  group_id INT,
  payment_status ENUM('pending','paid','failed') DEFAULT 'pending',
  payment_provider_ref VARCHAR(255),   -- transaction id од CPay/Stripe — НИКОГАШ card data
  purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES packages(id),
  FOREIGN KEY (group_id) REFERENCES groups_table(id)
) ENGINE=InnoDB;

-- ============ SEED DATA ============
INSERT INTO packages (name, price_mkd, lessons_per_month, description) VALUES
  ('Стартер', 1800.00, 4, 'За почетници кои сакаат да пробаат редовна настава.'),
  ('Стандард', 3200.00, 8, 'Најизбран пакет за континуиран напредок.'),
  ('Премиум', 5400.00, 999, 'Неограничени групни часови и приоритетна поддршка.')
ON DUPLICATE KEY UPDATE name = VALUES(name);
