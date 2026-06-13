#version 300 es
precision highp float;
precision highp int;

// particle quads are pre-billboarded on the CPU and supplied in world space.
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec2 a_texcoord;
layout(location = 2) in vec4 a_color;

uniform mat4 u_view_matrix;
uniform mat4 u_projection_matrix;

out vec2 v_texcoord;
out vec4 v_color;

void main() {
	v_texcoord = a_texcoord;
	v_color = a_color;
	gl_Position = u_projection_matrix * u_view_matrix * vec4(a_position, 1.0);
}
