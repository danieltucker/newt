-- A blog post's cover image.
--
-- Stored as a site-relative "/api/v1/images/<id>" path rather than an absolute
-- URL, matching how images embedded in a post body are written, so the value
-- keeps working across the dev origin, a LAN address and the public domain
-- without a rewrite. Empty string means the post has no hero.
--
-- Deliberately not a foreign key to "Image": a post body can already reference
-- any number of images with no such link, deleting an image is allowed to leave
-- a broken reference behind (see the DELETE /api/v1/images/:id comment), and a
-- cascade here would silently rewrite posts.

-- AlterTable
ALTER TABLE "BlogPost" ADD COLUMN "heroImage" TEXT NOT NULL DEFAULT '';
