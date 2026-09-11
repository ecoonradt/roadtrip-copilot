package com.roadtrip.copilot.model

import java.io.InputStream

/**
 * Interface abstraction for opening bundled asset files.
 * Allows pure JVM unit tests to supply asset files without requiring the Android runtime.
 */
fun interface AssetProvider {
    fun open(fileName: String): InputStream?
}
