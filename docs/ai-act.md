# EU AI Act, Article 50

Article 50 of the EU AI Act sets transparency obligations for AI systems that talk with people,
generate content, recognise emotions or produce deep fakes. This file records a verdict for each of
its four paragraphs, with the reason, for Tolsey as it runs by default.

## Article 50(1), interaction with a person: DOES NOT APPLY

The MCP server is deterministic. A reading is taken from the words and arguments a host sends,
matched against a fixed vocabulary, and judged against a rule row by plain code. Neither the server
nor the simulated wall display calls an AI model in the default configuration.

A live model may only ever sit behind one switch that the owner flips, and that switch is not built
yet. Its disclosure already is: the sentence in `src/contract/live-model.ts` is shown and spoken
first whenever the switch is on, and `src/contract/live-model.test.ts` pins it. If the switch is
built, this paragraph is decided again.

## Article 50(2), marking synthetic output: DOES NOT APPLY

Every reply is a fixed text template filled in with the reading, its verdict and its rule. No model
generates audio, images, video or text, so there is no synthetic output to mark.

## Article 50(3), emotion recognition and biometric categorisation: DOES NOT APPLY

Tolsey performs neither. It receives text and structured tool arguments, never audio or images, and
analyses no voice, face or body.

## Article 50(4), deep fakes and published text: DOES NOT APPLY

The product generates no image, audio or video of real people and publishes no generated text.
Material made about the product outside it carries its own row in the Determinations table of
`docs/privacy-accountability.md`.
