#version 300 es
precision highp float;
precision highp int;

in vec2 v_texcoord;
in vec4 v_color;

uniform sampler2D u_texture1;

out vec4 frag_color;

void main() {
	vec4 tex = texture(u_texture1, v_texcoord);

	// modulate the sampled texel by the per-particle colour/alpha. Blend state
	// (alpha / additive / etc.) is applied by the renderer via apply_blend_mode,
	// so the shader just outputs straight modulated colour.
	frag_color = tex * v_color;

	if (frag_color.a <= 0.0)
		discard;
}
