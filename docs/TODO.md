Bluesky Image Attachment Implementation
Step 1 — Authenticate

Create a session:

POST /xrpc/com.atproto.server.createSession

Receive:

accessJwt
did
handle
Step 2 — Upload Image

Upload the raw binary:

POST /xrpc/com.atproto.repo.uploadBlob
Authorization: Bearer ACCESS_JWT
Content-Type: image/png

(or jpg/webp/etc.)

The response looks similar to:

{
  "blob": {
    "$type": "blob",
    "ref": {
      "$link": "bafkreibabalobzn6cd366ukcsjycp4yymjymgfxcv6xczmlgpemzkz3cfa"
    },
    "mimeType": "image/png",
    "size": 13208
  }
}

Do not discard this object.

Store the entire blob object.

Step 3 — Create the Post

The uploaded blob is not automatically attached.

Instead, build the post like this:

{
  "repo": "did:plc:xxxxxxxx",
  "collection": "app.bsky.feed.post",
  "record": {
    "$type": "app.bsky.feed.post",

    "text": "Hello World",

    "createdAt": "2026-07-23T08:20:00.000Z",

    "embed": {
      "$type": "app.bsky.embed.images",

      "images": [
        {
          "alt": "Screenshot",

          "image": {
            "$type": "blob",

            "ref": {
              "$link": "bafk..."
            },

            "mimeType": "image/png",

            "size": 123456
          }
        }
      ]
    }
  }
}
Step 4 — Important

The important discovery from that forum thread:

Do NOT invent the blob.

Instead:

uploadBlob()

↓

response.blob

↓

embed.images[].image = response.blob

Literally reuse the object Bluesky returns.

Step 5 — Multiple Images

Just append more images:

"images": [

{
  "alt":"Image 1",
  "image": blob1
},

{
  "alt":"Image 2",
  "image": blob2
}

]

Bluesky supports multiple images.

Step 6 — Emerald Utilities Pipeline

Your publish flow should become:

Media selected

↓

Read file

↓

uploadBlob()

↓

blob object returned

↓

Store blob

↓

Create embed.images[]

↓

Create record

↓

createRecord()

↓

History log
Step 7 — Debug Logging

Log something like:

[BLUESKY]

Uploading image...

↓

Blob uploaded

mime=image/png

size=183452

cid=bafk...

↓

Creating embed

images=1

↓

Publishing post...

↓

Published successfully

Avoid dumping the JWT or full binary data.

Step 8 — Failure Cases

Detect separately:

Image upload failed

↓

Blob creation failed

↓

Embed creation failed

↓

Post creation failed

Don't collapse everything into "Publish failed."

Step 9 — Alt Text

Never hardcode:

alt: ""

If the user doesn't provide one, something like:

"Uploaded image"

is preferable.

Long-term, Emerald Utilities could allow optional alt text per image in the composer.

Step 10 — The Likely Bug in Your Logs

Earlier your log showed:

Media upload results:
{
 success:false,
 error:"Missing credentials"
}

That means you're not even reaching uploadBlob successfully.

The forum solution fixes the JSON structure after upload, but your current blocker is one step earlier:

✅ Login works.
❌ uploadBlob fails (Missing credentials).
Therefore mediaPaths=[].
Therefore no embed is created.
Text posts still work.

So I'd fix them in this order:

Make uploadBlob authenticate using the same valid accessJwt created during createSession.
Verify it returns a proper blob object.
Reuse that blob inside the embed.images JSON exactly as shown above.
Finally test with a PNG.

Once uploadBlob succeeds, you're very close. The text publishing pipeline is already working, and image support is mostly a matter of correctly threading the returned blob object into createRecord. I have a strong suspicion your remaining bug is localized to the upload/authentication path rather than the post creation itself.