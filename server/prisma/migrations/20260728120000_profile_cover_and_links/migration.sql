-- Profile cover and outbound links.
--
-- All three are additive and nullable-or-defaulted, so every existing row keeps
-- rendering exactly as it did: a NULL coverTheme means "derive the gradient from
-- the username", which is what the client already did for everyone.
ALTER TABLE "User" ADD COLUMN "coverImage" TEXT;
ALTER TABLE "User" ADD COLUMN "coverTheme" TEXT;
ALTER TABLE "User" ADD COLUMN "profileLinks" JSONB NOT NULL DEFAULT '[]';
